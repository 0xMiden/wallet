import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import type { ConsoleMessage } from '@playwright/test';

type ErrorMetadata = {
  kind: 'api-error' | 'transaction-error' | 'compact-sdk-error' | 'unknown';
  httpStatus?: number;
};
type ConsoleSource = {
  on(event: 'console', listener: (message: ConsoleMessage) => void): void;
  off(event: 'console', listener: (message: ConsoleMessage) => void): void;
};

export function epochSolveFailureMetadata(value: unknown): ErrorMetadata {
  try {
    if (typeof value !== 'object' || value === null) return { kind: 'unknown' };
    const name: unknown = Object.getOwnPropertyDescriptor(value, 'name')?.value;
    if (name === 'APIError') {
      const status: unknown = Object.getOwnPropertyDescriptor(value, 'status')?.value;
      return {
        kind: 'api-error',
        ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
          ? { httpStatus: status }
          : {})
      };
    }
    if (name === 'TransactionError') return { kind: 'transaction-error' };
    if (name === 'CompactSDKError') return { kind: 'compact-sdk-error' };
  } catch {
    // Error descriptors may be hostile; never invoke private getters or export their failures.
  }
  return { kind: 'unknown' };
}

export function observeEpochSolveFailure(source: ConsoleSource, checkpointPath: string): () => void {
  let key: Buffer;
  try {
    key = randomBytes(32);
  } catch {
    return () => {};
  }
  let active = true;
  let captured = false;
  const listener = (message: ConsoleMessage) => {
    try {
      if (!active || captured || message.type() !== 'error') return;
      const text = message.text();
      if (!text.startsWith('[EpochBridge] EVM→Miden solveIntent failed:')) return;
      captured = true;
      const basic = {
        site: 'evm-to-miden-solve',
        observedAt: new Date().toISOString(),
        errorSha256: createHmac('sha256', key).update(text).digest('hex')
      };
      const save = (metadata: unknown) => {
        try {
          let kind: ErrorMetadata['kind'] = 'unknown';
          let status: unknown;
          if (typeof metadata === 'object' && metadata !== null) {
            const candidate: unknown = Object.getOwnPropertyDescriptor(metadata, 'kind')?.value;
            if (candidate === 'api-error' || candidate === 'transaction-error' || candidate === 'compact-sdk-error')
              kind = candidate;
            status = Object.getOwnPropertyDescriptor(metadata, 'httpStatus')?.value;
          }
          writeFileSync(
            `${checkpointPath}.return-solve-failure.json`,
            JSON.stringify({
              ...basic,
              kind,
              ...(kind === 'api-error' &&
              typeof status === 'number' &&
              Number.isInteger(status) &&
              status >= 100 &&
              status <= 599
                ? { httpStatus: status }
                : {})
            }) + '\n',
            { mode: 0o600 }
          );
        } catch {
          // Diagnostics must not replace the original financial failure.
        }
      };
      save({ kind: 'unknown' });
      const error = message.args()[1];
      if (error)
        void error.evaluate(epochSolveFailureMetadata).then(
          metadata => {
            if (active) save(metadata);
          },
          () => {}
        );
    } catch {
      // Retain the immediate keyed record even if the browser handle disappears.
    }
  };
  try {
    source.on('console', listener);
  } catch {
    return () => {};
  }
  return () => {
    active = false;
    try {
      source.off('console', listener);
    } catch {
      // Page teardown must not change the original operation's result.
    }
  };
}
