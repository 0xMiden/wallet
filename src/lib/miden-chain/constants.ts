import { Endpoint, NetworkId } from '@miden-sdk/miden-sdk';

import { MidenNetwork } from 'lib/miden/types';

export const NETWORK_STORAGE_ID = 'network_id';

export enum MIDEN_NETWORK_NAME {
  MAINNET = 'mainnet',
  TESTNET = 'testnet',
  DEVNET = 'devnet',
  LOCALNET = 'localnet'
}

/**
 * The default network used throughout the app.
 * Driven by the MIDEN_NETWORK env variable at build time (default: testnet).
 * Use `yarn build:devnet` to build for devnet.
 */
export const DEFAULT_NETWORK = (process.env.MIDEN_NETWORK as MIDEN_NETWORK_NAME) || MIDEN_NETWORK_NAME.TESTNET;

export enum MIDEN_TRANSPORT_LAYER_NAME {
  TESTNET = 'testnet',
  LOCALNET = 'localnet'
}

export const MIDEN_NETWORK_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.MAINNET, 'https://api.miden.io'], // Placeholder
  [MIDEN_NETWORK_NAME.TESTNET, 'https://rpc.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://rpc.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:57291']
]);

export const MIDEN_PROVING_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://tx-prover.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://tx-prover.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:50051']
]);

export const MIDEN_FAUCET_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://faucet.testnet.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://faucet.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://localhost:8080']
]);

export const MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS = new Map<string, string>([
  [MIDEN_NETWORK_NAME.TESTNET, 'https://transport.miden.io'],
  [MIDEN_NETWORK_NAME.DEVNET, 'https://transport.devnet.miden.io'],
  [MIDEN_NETWORK_NAME.LOCALNET, 'http://127.0.0.1:57292']
]);

export const MIDEN_NETWORKS: MidenNetwork[] = [
  {
    rpcBaseURL: 'https://rpc.testnet.miden.io',
    id: MIDEN_NETWORK_NAME.TESTNET,
    name: 'Testnet',
    autoSync: true
  },
  {
    rpcBaseURL: 'https://rpc.devnet.miden.io',
    id: MIDEN_NETWORK_NAME.DEVNET,
    name: 'Devnet',
    autoSync: true
  },
  { rpcBaseURL: 'http://localhost:57291', id: MIDEN_NETWORK_NAME.LOCALNET, name: 'Localnet', autoSync: true }
];

export enum MidenTokens {
  Miden
}

export const TOKEN_MAPPING = {
  [MidenTokens.Miden]: { faucetId: 'mtst1aqmat9m63ctdsgz6xcyzpuprpulwk9vg_qruqqypuyph' }
};

export const DEFAULT_PSM_ENDPOINT = 'https://psm-stg.openzeppelin.com';

/**
 * Returns the SDK NetworkId for the current DEFAULT_NETWORK.
 */
export function getNetworkId(): NetworkId {
  const network: string = DEFAULT_NETWORK;
  switch (network) {
    /* c8 ignore start */
    case MIDEN_NETWORK_NAME.MAINNET:
      return NetworkId.mainnet();
    case MIDEN_NETWORK_NAME.DEVNET:
      return NetworkId.devnet();
    /* c8 ignore stop */
    case MIDEN_NETWORK_NAME.TESTNET:
    case MIDEN_NETWORK_NAME.LOCALNET:
    default:
      return NetworkId.testnet();
  }
}

/**
 * Returns the SDK Endpoint for the current DEFAULT_NETWORK.
 *
 * NOTE: this constructs a wasm-bindgen-backed `Endpoint` instance and
 * therefore requires the SDK's WASM module to be loaded on this thread.
 * Page-side callers should `await ensureSdkWasmReady()` first; otherwise
 * the constructor throws `TypeError: Cannot read properties of undefined
 * (reading '__wbindgen_malloc')` whenever it races SDK init.
 */
export function getRpcEndpoint(): Endpoint {
  const url = MIDEN_NETWORK_ENDPOINTS.get(DEFAULT_NETWORK)!;
  return new Endpoint(url);
}

/**
 * Resolves once the SDK's WASM module is loaded on the current thread, so
 * subsequent `new Endpoint(...)` / `new RpcClient(...)` calls are safe.
 *
 * On the extension page the SDK's WASM is loaded lazily — the first
 * `WebClient`-backed call (e.g. via `useSyncTrigger`) triggers it. Code that
 * reaches for `Endpoint` / `RpcClient` directly (currently
 * `fetchTokenMetadata` and `SendDetails`) doesn't go through that path and
 * fires before the chunk is ready, hitting `Cannot read properties of
 * undefined (reading '__wbindgen_malloc')`.
 *
 * We can't just probe-retry: nothing else triggers a load on the page side,
 * so the bindings stay undefined indefinitely. We have to actively call the
 * SDK's loadWasm. It isn't re-exported from the main entry, so we deep-import
 * it; the path is stable across the SDK versions we ship against, and the
 * probe at the end catches any future mismatch.
 */
let _sdkWasmReady: Promise<void> | null = null;
export function ensureSdkWasmReady(): Promise<void> {
  if (_sdkWasmReady) return _sdkWasmReady;
  _sdkWasmReady = (async () => {
    try {
      // Trigger the SDK's wasm-bindgen init. The SDK's package.json exports
      // map doesn't list the wasm-loader file directly; we import via a
      // Vite alias (`sdk-wasm-loader` → `node_modules/@miden-sdk/miden-sdk/
      // dist/wasm.js`) configured per build target.
      // @ts-expect-error -- virtual specifier resolved via Vite alias
      // eslint-disable-next-line import/no-unresolved
      const wasmModule = await import('sdk-wasm-loader');
      const loadWasm = wasmModule.default ?? wasmModule;
      if (typeof loadWasm === 'function') {
        await loadWasm();
      }
    } catch (err) {
      // Deep import unavailable (SDK refactor, unusual bundler) — fall through
      // to the probe loop below, which will at least surface a clear error
      // and let `_sdkWasmReady` retry next call.
      console.warn('ensureSdkWasmReady: deep loadWasm import unavailable, falling back to probe', err);
    }

    // Verify by probing — handles both the "loadWasm worked" happy path and
    // the "deep import failed but something else happens to have loaded WASM"
    // edge case. If neither, we throw and reset so the next caller retries.
    const delays = [0, 50, 150, 300];
    let lastErr: unknown;
    for (const delay of delays) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      try {
        new Endpoint('https://probe.invalid');
        return;
      } catch (err) {
        const msg = (err as { message?: string } | null)?.message ?? '';
        if (msg.includes('__wbindgen_malloc') || msg.includes('Cannot read properties of undefined')) {
          lastErr = err;
          continue;
        }
        return; // unrelated error — WASM is loaded, probe arg was just rejected
      }
    }
    _sdkWasmReady = null;
    throw new Error(
      `ensureSdkWasmReady: SDK WASM not loaded — ${(lastErr as { message?: string } | null)?.message ?? 'unknown'}`
    );
  })();
  return _sdkWasmReady;
}
