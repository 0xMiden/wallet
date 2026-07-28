import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

import { MOCK_USDC_ADDRESS } from './evm-doubles';

/**
 * Headless stand-in for the Epoch allocator (testnet-dev.epochprotocol.xyz) for
 * the bridge-IN USDC "Fast" deposit harness. The real allocator + solver are
 * hosted-only and watch REAL Sepolia, so a local Anvil deposit is invisible to
 * them — this fake answers the 4 endpoints the SDK hits on the EVM→Miden
 * resource-lock deposit path with canned responses, and lets the test program
 * the delivered note id so the wallet's note-id-based reconcile can complete.
 *
 * Endpoints (extracted from @epoch-protocol/epoch-intents-sdk/dist):
 *   GET  /suggested-nonce/{chainId}/{address}  → { success, nonce }   (hit twice)
 *   POST /checkIfDepositNeeded                 → quote w/ resourceLockRequired:true
 *   POST /compact                              → allocation ack
 *   GET  /intentStatus/{address}/{nonce}       → [] (pending) then Miden-leg success
 *
 * The app fetches these cross-origin from the WKWebView, so every response
 * carries permissive CORS headers and OPTIONS preflights are answered.
 */

const MIDEN_DESTINATION_CHAIN_ID = 999999999;

export interface AllocatorRequestLog {
  method: string;
  path: string;
  body?: unknown;
}

export class FakeEpochAllocator {
  private server?: Server;
  private midenNoteId: string | null = null;
  /** Every request served, for assertions (e.g. that a deposit was registered). */
  readonly requests: AllocatorRequestLog[] = [];

  constructor(private readonly port: number = 8548) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Program the note id the /intentStatus poll should report as delivered. */
  setMidenNoteId(noteId: string): void {
    this.midenNoteId = noteId;
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
          tokenIn: MOCK_USDC_ADDRESS,
          tokenOut: '1000000',
          tokenInDecimals: 6,
          tokenInSymbol: 'USDC'
        });
        return;
      }

      // POST /compact — allocation ack (the wallet reads nothing off this).
      if (method === 'POST' && path === '/compact') {
        this.send(res, 200, { hash: '0x00', signature: '0x00', digest: '0x00', nonce: '1' });
        return;
      }

      // GET /intentStatus/{address}/{nonce} — pending until the test programs the
      // delivered note id, then report the Miden leg as success with that id.
      if (method === 'GET' && path.startsWith('/intentStatus/')) {
        if (!this.midenNoteId) {
          this.send(res, 200, []);
          return;
        }
        this.send(res, 200, [
          {
            status: 'success',
            chainId: MIDEN_DESTINATION_CHAIN_ID,
            transactionHash: '',
            midenNoteId: this.midenNoteId
          }
        ]);
        return;
      }

      this.send(res, 404, { success: false, error: `unhandled ${method} ${path}` });
    });
  }
}
