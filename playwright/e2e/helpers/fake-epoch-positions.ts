import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

/**
 * Headless stand-in for the Epoch READ-ONLY positions service
 * (`EPOCH_POSITIONS_URL`, positions-testnet-dev.epochprotocol.xyz) for the EARN
 * e2e harness. The real service reads live on-chain lending state, which a local
 * harness can't populate — this fake serves a canned/programmable positions
 * payload in the EXACT shape `src/lib/epoch/positions.ts` parses.
 *
 * Two consumers, one payload:
 *   1. Vaults catalog — `fetchEarnPositions` derives an `EarnVaultInfo` from every
 *      item's `lenderInfo`/`aprData` (even zero-balance). The deposit flow needs a
 *      vault whose id (`lenderChainSlug(lenderKey, chainId)` = e.g.
 *      `dummy_lending-11155111`) the review CTA routes on — so a DUMMY_LENDING /
 *      Sepolia item must always be present.
 *   2. Open positions — `flattenChainItem` keeps a position only when it queried a
 *      REAL owner (not the neutral catalog account), the position's `marketUid`
 *      matches `EARN_MARKET_UID` (case-insensitive), and it has a non-zero deposit.
 *
 * ── Constants inlined on purpose (see fake-epoch-allocator.ts for rationale) ──
 *   - EARN_MARKET_UID = src/lib/epoch/earn.ts (`DUMMY_LENDING:11155111:0x2bb4…`)
 *   - EARN_UNDERLYING = src/lib/epoch/earn.ts (Sepolia USDC)
 */

/** `EARN_MARKET_UID` in src/lib/epoch/earn.ts (lowercase; matched case-insensitively). */
const EARN_MARKET_UID = 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
/** Sepolia USDC — `EARN_UNDERLYING` in src/lib/epoch/earn.ts. */
const EARN_UNDERLYING = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';
/** Ethereum Sepolia chain id (string, as the positions API returns it). */
const SEPOLIA_CHAIN_ID = '11155111';
/** Default lender for the only live earn market (Epoch's DUMMY_LENDING stand-in). */
const DUMMY_LENDING_KEY = 'DUMMY_LENDING';

// ── Raw positions-service response shapes (mirror src/lib/epoch/positions.ts,
//    which does not export them) ─────────────────────────────────────────────

interface PositionsChainItemAsset {
  name: string;
  symbol: string;
  address: string;
  chainId: string;
  logoURI: string | null;
  decimals: number;
  assetGroup: string;
}

export interface PositionsApiPosition {
  marketUid: string;
  deposits: string;
  debt: string;
  depositsUSD: number;
  withdrawable: string;
  collateralEnabled: boolean;
  underlyingInfo: {
    asset: PositionsChainItemAsset;
    prices: { priceUsd: number; priceChange24h: number };
  };
}

export interface PositionsApiChainItem {
  lender: string;
  chainId: string;
  aprData: { apr: number; depositApr: number; borrowApr: number };
  data: { positions: PositionsApiPosition[] }[];
  lenderInfo: { lenderKey: string; name: string; logoUri: string };
}

export interface PositionsRequestLog {
  method: string;
  path: string;
  account?: string;
  chains?: string;
}

export interface SeedDummyLendingOpts {
  /** Human-decimal deposit/withdrawable amount (e.g. '1.5'). Omit for a vault-only (zero-balance) catalog entry. */
  depositAmount?: string;
  /** USD value of the deposit (defaults to `Number(depositAmount)`). */
  depositsUSD?: number;
  /** Deposit APR percent shown on the vault + position (default 4.5). */
  depositApr?: number;
  /** Net APR percent for the vault (default = depositApr). */
  apr?: number;
  /** USDC price (default 1). */
  priceUsd?: number;
  /**
   * Underlying-asset decimals reported to the wallet (default 6, standard USDC).
   * The gasless WITHDRAW path validates `underlyingDecimals ===
   * BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS` (18, Epoch's amount convention), so a
   * withdraw seed must pass `decimals: 18` or `gaslessEarnWithdrawalToMiden`
   * throws "only supports the configured USDC Earn market" before creating a row.
   */
  decimals?: number;
}

/** Build a DUMMY_LENDING / Sepolia USDC chain item — a vault, optionally with a funded position. */
export function buildDummyLendingItem(opts: SeedDummyLendingOpts = {}): PositionsApiChainItem {
  const depositApr = opts.depositApr ?? 4.5;
  const apr = opts.apr ?? depositApr;
  const priceUsd = opts.priceUsd ?? 1;
  const asset: PositionsChainItemAsset = {
    name: 'USD Coin',
    symbol: 'USDC',
    address: EARN_UNDERLYING,
    chainId: SEPOLIA_CHAIN_ID,
    logoURI: null,
    decimals: opts.decimals ?? 6,
    assetGroup: 'stablecoin'
  };
  const positions: PositionsApiPosition[] = [];
  if (opts.depositAmount) {
    const depositsUSD = opts.depositsUSD ?? Number(opts.depositAmount);
    positions.push({
      marketUid: EARN_MARKET_UID,
      deposits: opts.depositAmount,
      debt: '0',
      depositsUSD,
      withdrawable: opts.depositAmount,
      collateralEnabled: true,
      underlyingInfo: { asset, prices: { priceUsd, priceChange24h: 0 } }
    });
  }
  return {
    lender: DUMMY_LENDING_KEY,
    chainId: SEPOLIA_CHAIN_ID,
    aprData: { apr, depositApr, borrowApr: 0 },
    data: [{ positions }],
    lenderInfo: { lenderKey: DUMMY_LENDING_KEY, name: 'Dummy Lending', logoUri: '' }
  };
}

export class FakeEpochPositions {
  private server?: Server;
  /** Per-owner (lowercased) canned chain-item arrays. */
  private readonly byOwner = new Map<string, PositionsApiChainItem[]>();
  /** Items returned for any owner without an explicit seed (also the neutral catalog account). */
  private defaultItems: PositionsApiChainItem[] = [buildDummyLendingItem()];
  /** Every request served, for assertions. */
  readonly requests: PositionsRequestLog[] = [];

  constructor(private readonly port: number = 8549) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Program the raw chain-item array returned for a specific EVM owner (case-insensitive). */
  setPosition(owner: string, items: PositionsApiChainItem[]): void {
    this.byOwner.set(owner.toLowerCase(), items);
  }

  /**
   * Seed a DUMMY_LENDING / Sepolia USDC vault for `owner`, optionally with one open
   * funded position. With `opts.depositAmount` set, the earn UI renders both the
   * vaults catalog AND a withdrawable position for `owner`; without it, only the
   * (zero-balance) vault catalog entry.
   */
  seedDummyLending(owner: string, opts: SeedDummyLendingOpts = {}): void {
    this.setPosition(owner, [buildDummyLendingItem(opts)]);
  }

  /** Override the fallback items served to un-seeded owners / the neutral catalog account. */
  setDefaultItems(items: PositionsApiChainItem[]): void {
    this.defaultItems = items;
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
    const url = req.url ?? '';
    const path = url.split('?')[0] ?? '';
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const account = query.get('account') ?? undefined;
    const chains = query.get('chains') ?? undefined;

    if (method === 'OPTIONS') {
      this.cors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    this.requests.push({ method, path, account, chains });

    // GET /positions?account={owner}&chains={csv}
    if (method === 'GET' && path === '/positions') {
      const items =
        account && this.byOwner.has(account.toLowerCase())
          ? this.byOwner.get(account.toLowerCase())!
          : this.defaultItems;
      this.send(res, 200, { success: true, data: { items } });
      return;
    }

    this.send(res, 404, { success: false, error: `unhandled ${method} ${path}` });
  }
}
