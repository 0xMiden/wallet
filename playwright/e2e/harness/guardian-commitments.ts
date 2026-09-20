import { targetOf, type GuardianOrigins } from './guardian-fault';

/**
 * Guardian settlement tracking, read off a wallet's own guardian traffic.
 *
 * A delta the wallet pushes (`POST /delta`) stays a candidate until the guardian's canonicalization worker
 * matches it against the chain, and `GET /state` keeps answering the previous commitment until then. While a
 * candidate is pending the guardian refuses every new proposal for the account with 409, and a device-key
 * rotation fails terminally on that by design (`REQUEUEABLE_ON_PENDING_CONFLICT`,
 * `src/lib/miden/transaction/index.ts`). A spec that hands an account to another wallet the moment its last
 * transaction lands therefore races the guardian. The ledger keeps each account's last pushed commitment and
 * its last canonical one, so the handoff can wait for the two to agree instead of guessing a delay.
 */

export type GuardianCommitmentRead = 'push' | 'state';

export interface UnsettledAccount {
  accountId: string;
  pushed: string;
  /** The last canonical commitment read back, if any. */
  canonical?: string;
}

export interface GuardianCommitmentLedger {
  /** Records a successful answer: a push's `new_commitment`, or a state read's `commitment`. */
  record(read: GuardianCommitmentRead, body: unknown): void;
  /** Accounts whose canonical state has not caught up with their last push. */
  unsettled(): UnsettledAccount[];
  /** How many accounts have a recorded push. */
  pushedAccounts(): number;
  /** How many state reads were recorded, for failure messages. */
  stateReads(): number;
}

const normalizeHex = (value: string): string => value.trim().toLowerCase().replace(/^0x/, '');

/** A non-empty string field of a JSON body, normalized as hex, or undefined. */
function hexField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value: unknown = Reflect.get(body, key);
  return typeof value === 'string' && value.trim() !== '' ? normalizeHex(value) : undefined;
}

export function createGuardianCommitmentLedger(): GuardianCommitmentLedger {
  const accounts = new Map<string, { pushed?: string; canonical?: string }>();
  let stateReads = 0;
  return {
    record(read, body) {
      const accountId = hexField(body, 'account_id');
      const commitment = hexField(body, read === 'push' ? 'new_commitment' : 'commitment');
      if (accountId === undefined || commitment === undefined) return;
      const entry = accounts.get(accountId) ?? {};
      if (read === 'push') {
        entry.pushed = commitment;
      } else {
        entry.canonical = commitment;
        stateReads++;
      }
      accounts.set(accountId, entry);
    },
    unsettled() {
      return [...accounts].flatMap(([accountId, { pushed, canonical }]) =>
        pushed !== undefined && canonical !== pushed ? [{ accountId, pushed, canonical }] : []
      );
    },
    pushedAccounts() {
      return [...accounts.values()].filter(entry => entry.pushed !== undefined).length;
    },
    stateReads() {
      return stateReads;
    }
  };
}

/**
 * Which settlement read a guardian request is: the push itself (`POST /delta`), or a canonical state read
 * (`GET /state`). Proposal traffic under `/delta/...`, delta reads and `/state/lookup` are neither.
 */
export function guardianCommitmentReadOf(
  method: string,
  url: string,
  origins: GuardianOrigins
): GuardianCommitmentRead | null {
  const target = targetOf(url, origins);
  if (target === null) return null;
  const origin = target === 'A' ? origins.a : origins.b;
  if (origin === undefined) return null;
  const path = url.slice(origin.replace(/\/+$/, '').length).split(/[?#]/)[0];
  if (method === 'POST' && path === '/delta') return 'push';
  if (method === 'GET' && path === '/state') return 'state';
  return null;
}

export interface ObservedResponse {
  ok(): boolean;
  text(): Promise<string>;
}

/** The Route surface observation touches. Playwright's `Route` satisfies it structurally. */
export interface ObservableRoute<R extends ObservedResponse> {
  fetch(options: { timeout: number }): Promise<R>;
  fulfill(options: { response: R }): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

/**
 * Sends the request on, records what a successful answer says, and hands the wallet exactly that answer. The
 * fetch has no deadline of its own, so a slow guardian is exactly as slow as it was under `route.continue()`.
 */
export async function observeGuardianRead<R extends ObservedResponse>(
  route: ObservableRoute<R>,
  read: GuardianCommitmentRead,
  ledger: GuardianCommitmentLedger
): Promise<void> {
  let response: R;
  try {
    response = await route.fetch({ timeout: 0 });
  } catch {
    // A request that failed on the wire fails for the wallet too, instead of staying pending.
    await route.abort('failed').catch(() => {});
    return;
  }
  if (response.ok()) {
    try {
      ledger.record(read, JSON.parse(await response.text()));
    } catch {
      // An unparseable body records nothing; the wallet still receives it unchanged.
    }
  }
  await route.fulfill({ response });
}

export interface SettleWaitOptions {
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Resolves, with the time it waited, once every pushed account's canonical state has caught up with its last
 * push. Call it after the wallet's queue has drained: nothing is left to push then, so a ledger without a push
 * means tracking started too late or never saw the traffic, and waiting cannot fix either.
 */
export async function waitForGuardianLedgerSettled(
  ledger: GuardianCommitmentLedger,
  {
    timeoutMs,
    pollMs = 1_000,
    now = Date.now,
    sleep = ms => new Promise<void>(resolve => setTimeout(resolve, ms))
  }: SettleWaitOptions
): Promise<number> {
  if (ledger.pushedAccounts() === 0) {
    throw new Error(
      'waitForGuardianSettled: no delta push was observed, so there is nothing to wait for; ' +
        'trackGuardianCommitments() has to run before the wallet transacts'
    );
  }
  const started = now();
  for (;;) {
    const unsettled = ledger.unsettled();
    if (unsettled.length === 0) return now() - started;
    if (now() - started >= timeoutMs) {
      const detail = unsettled
        .map(
          ({ accountId, pushed, canonical }) =>
            `account ${accountId} pushed ${pushed}, canonical ${canonical ?? 'never read'}`
        )
        .join('; ');
      throw new Error(
        `waitForGuardianSettled: the guardian has not canonicalized the last pushed delta after ${timeoutMs}ms ` +
          `(state reads observed: ${ledger.stateReads()}): ${detail}`
      );
    }
    await sleep(pollMs);
  }
}
