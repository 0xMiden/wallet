import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type MainnetOneClickPhase =
  | 'preflight'
  | 'execution-authorized'
  | 'forward-submitted'
  | 'miden-delivered'
  | 'reverse-submitted'
  | 'complete'
  | 'recovery-required';

export interface MainnetOneClickCheckpoint {
  version: 1;
  phase: MainnetOneClickPhase;
  routeId: string;
  symbol: string;
  principalBaseUnits: string;
  forwardOutputBaseUnits?: string;
  reverseOutputBaseUnits?: string;
  forwardCorrelationId?: string;
  forwardTransactionId?: string;
  reverseCorrelationId?: string;
  reverseEvmTransactionHash?: string;
  realizedCostUsdMicros?: string;
  updatedAt: string;
  sourceRunId?: string;
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPhase(value: unknown): value is MainnetOneClickPhase {
  return value === 'preflight' || value === 'execution-authorized' || value === 'forward-submitted' || value === 'miden-delivered' ||
    value === 'reverse-submitted' || value === 'complete' || value === 'recovery-required';
}

function parseCheckpoint(value: unknown): MainnetOneClickCheckpoint {
  if (!isRecord(value) || value.version !== 1 || !isPhase(value.phase) ||
      typeof value.routeId !== 'string' || typeof value.symbol !== 'string' ||
      typeof value.principalBaseUnits !== 'string' || !/^\d+$/.test(value.principalBaseUnits) ||
      typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('The saved mainnet 1Click checkpoint is invalid; inspect its recovery report before starting another loop');
  }
  const optionalAmounts: readonly ('forwardOutputBaseUnits' | 'reverseOutputBaseUnits' | 'realizedCostUsdMicros')[] = [
    'forwardOutputBaseUnits',
    'reverseOutputBaseUnits',
    'realizedCostUsdMicros'
  ];
  for (const key of optionalAmounts) {
    const entry = value[key];
    if (entry !== undefined && (typeof entry !== 'string' || !/^\d+$/.test(entry))) {
      throw new Error(`The saved mainnet 1Click checkpoint has an invalid ${key}`);
    }
  }
  if (value.note !== undefined && typeof value.note !== 'string') throw new Error('The saved mainnet 1Click checkpoint has an invalid note');
  if (value.sourceRunId !== undefined && (typeof value.sourceRunId !== 'string' || value.sourceRunId.length === 0 || value.sourceRunId.length > 64)) {
    throw new Error('The saved mainnet 1Click checkpoint has an invalid sourceRunId');
  }
  for (const key of ['forwardCorrelationId', 'forwardTransactionId', 'reverseCorrelationId', 'reverseEvmTransactionHash']) {
    const entry = value[key];
    if (entry !== undefined && (typeof entry !== 'string' || entry.length === 0 || entry.length > 256)) {
      throw new Error(`The saved mainnet 1Click checkpoint has an invalid ${key}`);
    }
  }
  return {
    version: 1,
    phase: value.phase,
    routeId: value.routeId,
    symbol: value.symbol,
    principalBaseUnits: value.principalBaseUnits,
    ...(typeof value.forwardOutputBaseUnits === 'string' ? { forwardOutputBaseUnits: value.forwardOutputBaseUnits } : {}),
    ...(typeof value.reverseOutputBaseUnits === 'string' ? { reverseOutputBaseUnits: value.reverseOutputBaseUnits } : {}),
    ...(typeof value.forwardCorrelationId === 'string' ? { forwardCorrelationId: value.forwardCorrelationId } : {}),
    ...(typeof value.forwardTransactionId === 'string' ? { forwardTransactionId: value.forwardTransactionId } : {}),
    ...(typeof value.reverseCorrelationId === 'string' ? { reverseCorrelationId: value.reverseCorrelationId } : {}),
    ...(typeof value.reverseEvmTransactionHash === 'string' ? { reverseEvmTransactionHash: value.reverseEvmTransactionHash } : {}),
    ...(typeof value.realizedCostUsdMicros === 'string' ? { realizedCostUsdMicros: value.realizedCostUsdMicros } : {}),
    updatedAt: value.updatedAt,
    ...(typeof value.sourceRunId === 'string' ? { sourceRunId: value.sourceRunId } : {}),
    ...(typeof value.note === 'string' ? { note: value.note } : {})
  };
}

export function loadMainnetOneClickCheckpoint(path: string): MainnetOneClickCheckpoint | undefined {
  try {
    return parseCheckpoint(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function saveMainnetOneClickCheckpoint(path: string, checkpoint: MainnetOneClickCheckpoint): void {
  const validated = parseCheckpoint(checkpoint);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...validated, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function assertMainnetOneClickMayStart(checkpoint: MainnetOneClickCheckpoint | undefined): void {
  if (!checkpoint || checkpoint.phase === 'complete') return;
  throw new Error(
    `A prior mainnet 1Click round trip is ${checkpoint.phase}. Resume or recover its existing principal before starting another outbound leg.`
  );
}
