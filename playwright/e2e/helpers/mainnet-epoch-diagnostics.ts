import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import type { ConsoleMessage } from '@playwright/test';

import { sanitizedTail } from '../../../scripts/mainnet-log-tail.mjs';

type ErrorMetadata = {
  kind: 'api-error' | 'transaction-error' | 'compact-sdk-error' | 'unknown';
  httpStatus?: number;
  code?: string;
  cause?: string;
};
type ConsoleSource = {
  on(event: 'console', listener: (message: ConsoleMessage) => void): void;
  off(event: 'console', listener: (message: ConsoleMessage) => void): void;
};

// Runs in the browser page, so it must stay self-contained. Own data descriptors only: getters are never invoked.
export function epochSolveFailureMetadata(value: unknown): ErrorMetadata {
  try {
    if (typeof value !== 'object' || value === null) return { kind: 'unknown' };
    const own = (target: object, key: string): unknown => Object.getOwnPropertyDescriptor(target, key)?.value;
    const name = own(value, 'name');
    let result: ErrorMetadata;
    if (name === 'APIError') {
      const status = own(value, 'status');
      result = {
        kind: 'api-error',
        ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
          ? { httpStatus: status }
          : {})
      };
    } else if (name === 'TransactionError') result = { kind: 'transaction-error' };
    else if (name === 'CompactSDKError') result = { kind: 'compact-sdk-error' };
    else return { kind: 'unknown' };
    const code = own(value, 'code');
    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) result.code = code;
    let root: object = value;
    for (let depth = 0; depth < 5; depth++) {
      const next = own(root, 'cause');
      if (typeof next !== 'object' || next === null) break;
      root = next;
    }
    const rootName = own(root, 'name');
    const rootMessage = own(root, 'message');
    result.cause = `${typeof rootName === 'string' ? rootName : ''}: ${
      typeof rootMessage === 'string' ? rootMessage.split('\n')[0] : ''
    }`.slice(0, 400);
    return result;
  } catch {
    // Error descriptors may be hostile; never invoke private getters or export their failures.
  }
  return { kind: 'unknown' };
}

// The browser-side cause is bounded text; it still goes through the public log sanitizer before it is saved or printed.
function publicCause(raw: string): string {
  const secrets = Object.entries(process.env)
    .filter(([key]) => key.startsWith('E2E_MAINNET_'))
    .map(([, value]) => value ?? '');
  return sanitizedTail(raw, secrets)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\?\S+/g, '?[query]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

// Keeps the generic unresolved message but carries a sanitized name and first message line as its cause.
export function unresolvedSubmissionError(raw: unknown): Error {
  let name = 'Error';
  let text = '';
  try {
    const record = typeof raw === 'object' && raw !== null ? raw : undefined;
    const rawName = record && Object.getOwnPropertyDescriptor(record, 'name')?.value;
    const rawMessage = record ? Object.getOwnPropertyDescriptor(record, 'message')?.value : raw;
    if (typeof rawName === 'string') name = publicCause(rawName.slice(0, 80));
    if (typeof rawMessage === 'string') text = publicCause(rawMessage.split('\n')[0].slice(0, 400));
  } catch {
    // A hostile error object must not replace the unresolved-submission failure.
  }
  const cause = new Error(text);
  cause.name = name;
  return new Error('Epoch EVM submission is unresolved; reconcile the saved signed hashes before any further signing', {
    cause
  });
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
          let status: unknown, code: unknown, rawCause: unknown;
          if (typeof metadata === 'object' && metadata !== null) {
            const candidate: unknown = Object.getOwnPropertyDescriptor(metadata, 'kind')?.value;
            if (candidate === 'api-error' || candidate === 'transaction-error' || candidate === 'compact-sdk-error')
              kind = candidate;
            status = Object.getOwnPropertyDescriptor(metadata, 'httpStatus')?.value;
            code = Object.getOwnPropertyDescriptor(metadata, 'code')?.value;
            rawCause = Object.getOwnPropertyDescriptor(metadata, 'cause')?.value;
          }
          let cause: string | undefined;
          if (kind !== 'unknown' && typeof rawCause === 'string') {
            cause = publicCause(rawCause.slice(0, 400));
            console.error(`Epoch solve failure cause: ${cause}`);
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
                : {}),
              ...(kind !== 'unknown' && typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)
                ? { code }
                : {}),
              ...(cause !== undefined ? { cause } : {})
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
