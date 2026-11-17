import type { ConsoleMessage } from '@playwright/test';

type ErrorMetadata = {
  kind: 'api-error' | 'transaction-error' | 'compact-sdk-error' | 'unknown';
  httpStatus?: number;
};
type ConsoleSource = {
  on(event: 'console', listener: (message: ConsoleMessage) => void): void;
  off(event: 'console', listener: (message: ConsoleMessage) => void): void;
};

export function epochSolveFailureMetadata(_value: unknown): ErrorMetadata {
  return { kind: 'unknown' };
}

export function observeEpochSolveFailure(_source: ConsoleSource, _checkpointPath: string): () => void {
  return () => {};
}
