import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

/**
 * Headless stand-in for the Epoch allocator (`EPOCH_ALLOCATOR_URL`,
 * testnet-dev.epochprotocol.xyz) for the EARN (Epoch lending) e2e harness.
 *
 * This is the earn-capable sibling of `playwright/e2e/ios/helpers/fake-epoch-allocator.ts`
 * (the bridge-IN fake). The real allocator + solver are hosted-only and watch REAL
 * Sepolia, so the local harness can't drive them — this fake answers every endpoint
 * the SDK hits on BOTH earn paths with canned/programmable responses:
 *
 *   Deposit (open lending position — Miden→Sepolia):
 *     GET  /suggested-nonce/{chainId}/{address}  → { success, nonce }
 *     POST /checkIfDepositNeeded                 → quote w/ resourceLockRequired:true
 *     GET  /miden-recipient                      → allocator Miden collateral config
 *     POST /compact                              → allocation ack
 *     GET  /intentStatus/{address}/{nonce}       → programmable per-leg status array
 *
 *   Withdraw (gasless redeem + bridge back — Sepolia→Miden, phase 2):
 *     GET  /gasless-status                       → relayer address (see caveat below)
 *     GET  /health                               → relayer fallback + { ok }
 *     POST /relay-enable-delegation              → { ok }
 *     POST /relay-execute                        → { nonce } (programmable)
 *
 * The app fetches these cross-origin, so every response carries permissive CORS
 * headers and OPTIONS preflights are answered.
 *
 * ── Constants are inlined on purpose ──────────────────────────────────────────
 * Importing `src/lib/epoch/earn.ts` would drag the whole Epoch SDK + browser-only
 * `lib/miden/*` import graph into this node:http server. The values below mirror
 * the source-of-truth constants (kept in sync manually):
 *   - EARN_UNDERLYING            = src/lib/epoch/earn.ts        (Sepolia USDC)
 *   - EARN_DESTINATION_CHAIN_ID  = src/lib/epoch/earn.ts        (11155111)
 *   - MIDEN_DESTINATION_CHAIN_ID = src/lib/epoch/config.ts      (999999999)
 */

/** Sepolia USDC — `EARN_UNDERLYING` in src/lib/epoch/earn.ts. */
const EARN_UNDERLYING = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';
/** Ethereum Sepolia — `EARN_DESTINATION_CHAIN_ID` (the deposit/lending leg). */
const EARN_DESTINATION_CHAIN_ID = 11155111;
/** Virtual Miden chain id — `MIDEN_DESTINATION_CHAIN_ID` (the withdraw/bridge leg). */
const MIDEN_DESTINATION_CHAIN_ID = 999999999;

/**
 * Default allocator Miden collateral recipient — the account the P2IDE collateral
 * note is addressed to. Programmable via `setMidenRecipient`; the e2e harness
 * overrides this with the real allocator account minted at test time. Shape is a
 * Miden account id (hex `0x…` or bech32); `createEarnP2IDNote` runs it through
 * `ifHextoBech32`, so a `0x` hex id is converted to bech32 before minting.
 */
const DEFAULT_MIDEN_RECIPIENT = '0x2458e5446128e6b150b75b8ebd9ce1';

/** Default reclaim minimum the allocator advertises (`midenMinReclaimBlocks`). */
const DEFAULT_MIN_RECLAIM_BLOCKS = 100;

export interface AllocatorRequestLog {
  method: string;
  path: string;
  body?: unknown;
}

/** Terminal status the deposit poller accepts on the Sepolia leg (`EARN_DONE_STATUSES`). */
export type EarnDepositStatus = 'completed' | 'finalized' | 'success' | 'filled' | 'settled';

export class FakeEpochAllocator {
  private server?: Server;
  /** Withdraw / Miden leg — the delivered bridged-note id, once programmed. */
  private midenNoteId: string | null = null;
  /** Deposit / Sepolia leg — the lending-fill status, once programmed. */
  private earnDepositStatus: EarnDepositStatus | null = null;
  /** Allocator Miden collateral recipient account id. */
  private midenRecipient: string = DEFAULT_MIDEN_RECIPIENT;
  /** Nonce echoed back from POST /relay-execute (the gasless withdraw submit). */
  private withdrawNonce: string = 'earn-withdraw-nonce-1';
  /** Every request served, for assertions. */
  readonly requests: AllocatorRequestLog[] = [];

  constructor(private readonly port: number = 8548) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Program the delivered note id the /intentStatus poll reports on the Miden
   * (withdraw destination) leg. Setting it makes the withdraw poll resolve `done`
   * and lets the wallet's note-id reconcile complete.
   */
  setMidenNoteId(noteId: string): void {
    this.midenNoteId = noteId;
  }

  /**
   * Program the lending-fill status the /intentStatus poll reports on the Sepolia
   * (deposit destination) leg. Setting it (default `'completed'`) makes the
   * deposit poll resolve `done` (`resolveEarnIntentOutcome` gates on chainId
   * 11155111 with a status in {completed,finalized,success,filled,settled}).
   */
  setEarnDepositOutcome(status: EarnDepositStatus = 'completed'): void {
    this.earnDepositStatus = status;
  }

  /** Program the allocator Miden collateral recipient (GET /miden-recipient). */
  setMidenRecipient(recipient: string): void {
    this.midenRecipient = recipient;
  }

  /** Program the nonce POST /relay-execute echoes back for the gasless withdraw. */
  setWithdrawNonce(nonce: string): void {
    this.withdrawNonce = nonce;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private cors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    this.cors(res);
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = status;
    res.end(JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '').split('?')[0] ?? '';

    if (method === 'OPTIONS') {
      this.cors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      this.requests.push({ method, path, body });

      // ── Deposit path ────────────────────────────────────────────────────────

      // GET /suggested-nonce/{chainId}/{address}
      if (method === 'GET' && path.startsWith('/suggested-nonce/')) {
        this.send(res, 200, { success: true, nonce: '1' });
        return;
      }

      // POST /checkIfDepositNeeded — resourceLockRequired:true routes the on-chain
      // deposit branch; tokenIn/tokenInDecimals present so no path-parsing runs.
      if (method === 'POST' && path === '/checkIfDepositNeeded') {
        this.send(res, 200, {
          success: true,
          resourceLockRequired: true,
          transactions: [],
          path: [],
          tokenIn: EARN_UNDERLYING,
          tokenOut: '1000000',
          tokenInDecimals: 6,
          tokenInSymbol: 'USDC'
        });
        return;
      }

      // GET /miden-recipient — allocator collateral config. Field names match what
      // the SDK's `getMidenCollateralConfig` reads: `midenP2IDRecipientAccountId`
      // (required — throws if absent) and `midenMinReclaimBlocks` (optional).
      if (method === 'GET' && path === '/miden-recipient') {
        this.send(res, 200, {
          success: true,
          midenP2IDRecipientAccountId: this.midenRecipient,
          midenMinReclaimBlocks: DEFAULT_MIN_RECLAIM_BLOCKS
        });
        return;
      }

      // POST /compact — allocation ack (the wallet reads nothing meaningful off this).
      if (method === 'POST' && path === '/compact') {
        this.send(res, 200, { hash: '0x00', signature: '0x00', digest: '0x00', nonce: '1' });
        return;
      }

      // GET /intentStatus/{address}/{nonce} — returns the array of whichever legs
      // are programmed. Deposit gates 'done' on the Sepolia leg (11155111); withdraw
      // gates on the Miden leg (999999999) and reads `midenNoteId`. Returns [] until
      // at least one leg is programmed (pending), both entries if both are set.
      if (method === 'GET' && path.startsWith('/intentStatus/')) {
        const legs: Array<Record<string, unknown>> = [];
        if (this.earnDepositStatus) {
          legs.push({
            status: this.earnDepositStatus,
            chainId: EARN_DESTINATION_CHAIN_ID,
            transactionHash: '0x00'
          });
        }
        if (this.midenNoteId) {
          legs.push({
            status: 'success',
            chainId: MIDEN_DESTINATION_CHAIN_ID,
            transactionHash: '',
            midenNoteId: this.midenNoteId
          });
        }
        this.send(res, 200, legs);
        return;
      }

      // ── Withdraw (gasless) path ───────────────────────────────────────────────
      // CAVEAT (see API-reference notes): the SDK's is7702Capable / needsSetup are
      // NOT derived from this endpoint. `getWalletGaslessStatus` computes them from
      // the walletClient + ON-CHAIN delegation state (readDelegationState / getCode).
      // /gasless-status only supplies `relayerAddress` (relay signer). We return
      // generous flags too in case a future SDK reads them, but the 7702 gating is
      // controlled by the EVM double / walletClient, not here.

      if (method === 'GET' && path === '/gasless-status') {
        this.send(res, 200, {
          ok: true,
          relayerAddress: '0x0000000000000000000000000000000000000001',
          is7702Capable: true,
          needsSetup: false,
          gaslessEnabled: true,
          supported: true
        });
        return;
      }

      // GET /health — relayer-address fallback when /gasless-status is unavailable;
      // `signingAddress` is read as the relayer. `{ ok: true }` per the task.
      if (method === 'GET' && path === '/health') {
        this.send(res, 200, { ok: true, signingAddress: '0x0000000000000000000000000000000000000001' });
        return;
      }

      // POST /relay-enable-delegation — 7702 delegation enablement ack.
      if (method === 'POST' && path === '/relay-enable-delegation') {
        this.send(res, 200, { ok: true });
        return;
      }

      // POST /relay-execute — the gasless withdraw submit. `executeActions` reads
      // `nonce` off this to track delivery; programmable via setWithdrawNonce.
      if (method === 'POST' && path === '/relay-execute') {
        this.send(res, 200, { ok: true, nonce: this.withdrawNonce });
        return;
      }

      this.send(res, 404, { success: false, error: `unhandled ${method} ${path}` });
    });
  }
}
