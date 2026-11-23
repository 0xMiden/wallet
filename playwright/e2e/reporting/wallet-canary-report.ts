import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { schema } from '../../../scripts/wallet-e2e/report.cjs';

export const WALLET_CANARY_REPORT_FILENAME = 'wallet-canary-report-v1.json';
export const WALLET_CANARY_WORKFLOW_PATH = '.github/workflows/e2e-mainnet-wallet-canary.yml';
const REPORT_VERSION = 'wallet-e2e/canary-report-v1';
const REPOSITORY_ID = '853430876';
const SOURCE_REF = 'refs/heads/main';
const JOB_KEY = 'wallet-canary';
const SLOT_DURATION_MS = 5 * 60_000;
const ASSETS: readonly string[] = schema.$defs.tokenSymbol.enum;
const STAGES = [
  'admission',
  'authorization_released',
  'submission',
  'inclusion',
  'partial_fill',
  'full_fill',
  'payback',
  'claim',
  'usable_receipt',
  'timed_out',
  'cancelled',
  'reclaimed'
] as const;

export type WalletCanaryStage = (typeof STAGES)[number];
export type WalletCanaryObservation = { stage: WalletCanaryStage; at: string };

export type WalletCanarySource = {
  repositoryId: string;
  workflowId: string;
  workflowPath: string;
  sourceRef: string;
  sourceSha: string;
  jobKey: string;
  runId: string;
  runAttempt: string;
};

export type WalletCanaryOriginal = { runId: string; runAttempt: string; slotStart: string; lineageId: string };

const REASONS = {
  blocked: ['busy_wallet', 'quote_unavailable', 'budget_exhausted', 'confirmed_not_submitted'],
  admitted: [null],
  unknown: [null, 'submission_unconfirmed'],
  submitted: [null],
  usable_receipt: [null]
} as const;

export type WalletCanarySlot = {
  slotStart: string;
  status: keyof typeof REASONS;
  reason: (typeof REASONS)[keyof typeof REASONS][number];
  admittedAt: string | null;
  submittedAt: string | null;
  usableReceiptAt: string | null;
  claimMode: 'manual' | null;
  runId: string | null;
  runAttempt: string | null;
};

export type WalletCanaryPair = { offered: string; requested: string };
export type WalletCanaryTerms = {
  offeredBaseUnits: string;
  minimumBaseUnits: string;
  offeredDecimals: number;
  requestedDecimals: number;
};

export type WalletCanaryReportInput = {
  source: WalletCanarySource;
  original: WalletCanaryOriginal;
  slot: WalletCanarySlot;
  observations: readonly WalletCanaryObservation[];
  pair: WalletCanaryPair | null;
  terms: WalletCanaryTerms | null;
};

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
}

function tokenAmount(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
}

function decimals(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 24;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))
    throw new Error('Invalid wallet canary timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || walletCanaryTimestamp(ms) !== value) throw new Error('Invalid wallet canary timestamp');
  return ms;
}

export function walletCanaryTimestamp(ms = Date.now()): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

// The registration ID comes from protected runner configuration once the workflow exists on main.
export function walletCanarySourceFromEnvironment(env = process.env): WalletCanarySource {
  if (
    env.GITHUB_REPOSITORY !== '0xMiden/wallet' ||
    env.GITHUB_WORKFLOW_REF !== `0xMiden/wallet/${WALLET_CANARY_WORKFLOW_PATH}@${SOURCE_REF}`
  )
    throw new Error('Invalid wallet canary workflow environment');
  return projectSource({
    repositoryId: env.GITHUB_REPOSITORY_ID ?? '',
    workflowId: env.MAINNET_CANARY_WORKFLOW_ID ?? '',
    workflowPath: WALLET_CANARY_WORKFLOW_PATH,
    sourceRef: env.GITHUB_REF ?? '',
    sourceSha: env.GITHUB_SHA ?? '',
    jobKey: env.GITHUB_JOB ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? ''
  });
}

function projectSource(value: WalletCanarySource): WalletCanarySource {
  const { repositoryId, workflowId, workflowPath, sourceRef, sourceSha, jobKey, runId, runAttempt } = value;
  if (
    repositoryId !== REPOSITORY_ID ||
    !id(workflowId) ||
    workflowPath !== WALLET_CANARY_WORKFLOW_PATH ||
    sourceRef !== SOURCE_REF ||
    typeof sourceSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(sourceSha) ||
    jobKey !== JOB_KEY ||
    !id(runId) ||
    !id(runAttempt)
  )
    throw new Error('Invalid wallet canary report source');
  return { repositoryId, workflowId, workflowPath, sourceRef, sourceSha, jobKey, runId, runAttempt };
}

function projectOriginal(value: WalletCanaryOriginal): WalletCanaryOriginal {
  const { runId, runAttempt, slotStart, lineageId } = value;
  if (
    !id(runId) ||
    !id(runAttempt) ||
    timestamp(slotStart) % SLOT_DURATION_MS !== 0 ||
    typeof lineageId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(lineageId)
  )
    throw new Error('Invalid wallet canary original slot identity');
  return { runId, runAttempt, slotStart, lineageId };
}

function projectSlot(value: WalletCanarySlot, original: WalletCanaryOriginal): WalletCanarySlot {
  const { slotStart, status, reason, admittedAt, submittedAt, usableReceiptAt, claimMode, runId, runAttempt } = value;
  if (
    slotStart !== original.slotStart ||
    runId !== original.runId ||
    runAttempt !== original.runAttempt ||
    !Object.hasOwn(REASONS, status) ||
    !(REASONS[status] as readonly unknown[]).includes(reason) ||
    (claimMode !== null && claimMode !== 'manual') ||
    (admittedAt !== null && claimMode !== 'manual') ||
    (status === 'submitted' || status === 'usable_receipt') !== (submittedAt !== null) ||
    (status === 'usable_receipt') !== (usableReceiptAt !== null) ||
    (status === 'admitted' && admittedAt === null) ||
    (reason === 'submission_unconfirmed' && admittedAt === null)
  )
    throw new Error('Invalid wallet canary slot disposition');
  const slot = timestamp(slotStart);
  const admission = admittedAt === null ? null : timestamp(admittedAt);
  const submission = submittedAt === null ? null : timestamp(submittedAt);
  const receipt = usableReceiptAt === null ? null : timestamp(usableReceiptAt);
  if (
    (admission !== null && (admission < slot || admission >= slot + SLOT_DURATION_MS)) ||
    (submission !== null && (admission === null || submission < admission)) ||
    (receipt !== null && (submission === null || receipt < submission))
  )
    throw new Error('Wallet canary milestone chronology is invalid');
  return { slotStart, status, reason, admittedAt, submittedAt, usableReceiptAt, claimMode, runId, runAttempt };
}

function projectObservations(
  values: readonly WalletCanaryObservation[],
  slot: WalletCanarySlot,
  reconciled: boolean
): WalletCanaryObservation[] {
  const times = new Map<WalletCanaryStage, string>();
  let previous = timestamp(slot.slotStart);
  if (!Array.isArray(values) || values.length > STAGES.length) throw new Error('Invalid wallet canary observations');
  const observations = values.map(({ stage, at }) => {
    const instant = timestamp(at);
    if (
      !STAGES.includes(stage) ||
      times.has(stage) ||
      instant < previous ||
      (reconciled && (stage === 'admission' || stage === 'authorization_released'))
    )
      throw new Error('Invalid wallet canary observation');
    times.set(stage, at);
    previous = instant;
    return { stage, at };
  });

  const milestones = [
    ['admission', slot.admittedAt],
    ['submission', slot.submittedAt],
    ['usable_receipt', slot.usableReceiptAt]
  ] as const;
  for (const [stage, expected] of milestones) {
    const actual = times.get(stage) ?? null;
    if ((!reconciled || actual !== null) && actual !== expected)
      throw new Error('Wallet canary report has an unsupported milestone');
  }
  if (
    (times.has('authorization_released') &&
      (slot.admittedAt === null || times.get('authorization_released')! < slot.admittedAt)) ||
    (times.has('reclaimed') && (slot.submittedAt === null || slot.usableReceiptAt !== null))
  )
    throw new Error('Wallet canary report has contradictory observations');
  return observations;
}

function projectPair(pair: WalletCanaryPair | null): WalletCanaryPair | null {
  if (pair === null) return null;
  const offered = pair.offered === 'USDCX' ? 'USDCx' : pair.offered;
  const requested = pair.requested === 'USDCX' ? 'USDCx' : pair.requested;
  if (!ASSETS.includes(offered) || !ASSETS.includes(requested) || offered === requested)
    throw new Error('Invalid wallet canary token pair');
  return { offered, requested };
}

function projectTerms(terms: WalletCanaryTerms | null, pair: WalletCanaryPair | null): WalletCanaryTerms | null {
  if (terms === null) return null;
  const { offeredBaseUnits, minimumBaseUnits, offeredDecimals, requestedDecimals } = terms;
  if (
    pair === null ||
    !tokenAmount(offeredBaseUnits) ||
    !tokenAmount(minimumBaseUnits) ||
    !decimals(offeredDecimals) ||
    !decimals(requestedDecimals)
  )
    throw new Error('Invalid wallet canary quote terms');
  return { offeredBaseUnits, minimumBaseUnits, offeredDecimals, requestedDecimals };
}

export function writeWalletCanaryReport(targetDirectory: string, input: WalletCanaryReportInput): string {
  const source = projectSource(input.source);
  const original = projectOriginal(input.original);
  if (source.runId === original.runId && source.runAttempt !== original.runAttempt)
    throw new Error('A rerun cannot originate a new wallet canary report');
  const slot = projectSlot(input.slot, original);
  const observations = projectObservations(input.observations, slot, source.runId !== original.runId);
  const pair = projectPair(input.pair);
  const terms = projectTerms(input.terms, pair);
  const content = JSON.stringify({ schemaVersion: REPORT_VERSION, source, original, slot, observations, pair, terms });
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const path = join(targetDirectory, WALLET_CANARY_REPORT_FILENAME);
  const temporary = join(targetDirectory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${content}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    return path;
  } finally {
    rmSync(temporary, { force: true });
  }
}
