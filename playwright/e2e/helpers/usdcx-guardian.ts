/**
 * The hosted Guardian's side of the USDCx suites: who it was when the run started, what a failure should say about it,
 * and the two row checks that tell a Guardian fault from a wallet one.
 */
import type { Hex } from 'viem';

import type { BridgedSendRow } from './bridge';
import { describeTransactionRow, TxStatus, type TransactionRowSnapshot } from './history';
import { GUARDIAN_ECDSA_SCHEME } from './usdcx-constants';

export interface GuardianIdentity {
  url: string;
  version: string;
  gitCommit: string;
  environment: string;
  /** The ECDSA key commitment the account's `update_guardian` procedure must name. */
  commitment: Hex;
  pubkey: Hex;
}

const IDENTITY_TIMEOUT_MS = 15_000;
const CONTEXT_TIMEOUT_MS = 5_000;

async function getJson(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new Error(`GET ${url}: not a JSON object`);
  return Object.fromEntries(Object.entries(body));
}

function text(body: Record<string, unknown>, key: string, url: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value === '') throw new Error(`GET ${url}: no ${key}`);
  return value;
}

function hexField(body: Record<string, unknown>, key: string, url: string, length: number): Hex {
  const value = text(body, key, url);
  if (!new RegExp(`^0x[0-9a-fA-F]{${length}}$`).test(value))
    throw new Error(`GET ${url}: ${key} ${value} is not ${length} hex`);
  return `0x${value.slice(2).toLowerCase()}`;
}

/** `/status` (which must say ok) and the ECDSA key from `/pubkey?scheme=ecdsa`, recorded once per run. */
export async function guardianIdentity(url: string, fetchImpl: typeof fetch = fetch): Promise<GuardianIdentity> {
  const statusUrl = `${url}/status`;
  const status = await getJson(statusUrl, fetchImpl, IDENTITY_TIMEOUT_MS);
  if (status.status !== 'ok') throw new Error(`GET ${statusUrl}: status ${JSON.stringify(status.status)}, not "ok"`);
  const pubkeyUrl = `${url}/pubkey?scheme=${GUARDIAN_ECDSA_SCHEME}`;
  const pubkey = await getJson(pubkeyUrl, fetchImpl, IDENTITY_TIMEOUT_MS);
  return {
    url,
    version: text(status, 'version', statusUrl),
    gitCommit: text(status, 'git_commit', statusUrl),
    environment: text(status, 'environment', statusUrl),
    commitment: hexField(pubkey, 'commitment', pubkeyUrl, 64),
    pubkey: hexField(pubkey, 'pubkey', pubkeyUrl, 66)
  };
}

/**
 * The Guardian lines of a failure message (spec section 11): the URL, the identity recorded at the start, and a
 * best-effort `/status` re-read, with both shown when they differ. Never throws: it decorates another failure.
 */
export async function guardianFailureContext(
  identity: GuardianIdentity,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const recorded = `version ${identity.version}, git_commit ${identity.gitCommit}, environment ${identity.environment}`;
  const head = `Guardian ${identity.url} (at start: ${recorded}; ECDSA commitment ${identity.commitment})`;
  try {
    const status = await getJson(`${identity.url}/status`, fetchImpl, CONTEXT_TIMEOUT_MS);
    const now = `status ${String(status.status)}, version ${String(status.version)}, git_commit ${String(status.git_commit)}, environment ${String(status.environment)}`;
    const same =
      status.status === 'ok' &&
      status.version === identity.version &&
      status.git_commit === identity.gitCommit &&
      status.environment === identity.environment;
    return same ? `${head}; re-read: unchanged` : `${head}; re-read DIFFERS: ${now}`;
  } catch (error) {
    return `${head}; re-read failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Throws listing `accountId`'s rows still Queued or GeneratingTransaction: a burn must not overlap another write. */
export function assertNoGuardianOpInFlight(rows: readonly TransactionRowSnapshot[], accountId: string): void {
  // Rows keep the composite id; compare bech32 parts so a bare and a composite form of one account match.
  const bare = (id: string): string => id.split('_')[0] ?? id;
  const account = bare(accountId);
  const inFlight = rows.filter(
    row =>
      row.accountId !== undefined &&
      bare(row.accountId) === account &&
      (row.status === TxStatus.Queued || row.status === TxStatus.GeneratingTransaction)
  );
  if (inFlight.length > 0) {
    throw new Error(
      `${inFlight.length} transaction(s) of ${accountId} still in flight; a Guardian write would overlap them:\n` +
        inFlight.map(row => `  ${describeTransactionRow(row)}`).join('\n')
    );
  }
}

/** A Failed or stuck USDCx burn row as the failure message spec section 11 asks for. */
export function burnFailureMessage(row: BridgedSendRow): string {
  const raw = row.rawError ?? '';
  const lines = [
    `USDCx burn row ${row.id}: status ${row.status}, stage ${row.stage ?? '-'}`,
    `  error: ${row.error ?? '-'}`,
    `  rawError: ${raw || '-'}`,
    `  stageTimestamps: ${JSON.stringify(row.stageTimestamps ?? {})}`,
    `  submitEvidence: ${JSON.stringify(row.submitEvidence ?? [])}`
  ];
  if (/\b409\b|pending canonicalization/i.test(raw)) lines.push('  the prior Guardian candidate had not settled');
  return lines.join('\n');
}
