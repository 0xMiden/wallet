import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';

import { SignatureCheckError } from '../chain-testnet/signature.js';
import { OrderConflictError } from '../orders/store.js';
import { TransakError } from '../transak/client.js';

/** An error with a fixed HTTP status and a message that is safe to send to the client. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function isBodyParserError(error: unknown): error is { status: number; type: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    'type' in error &&
    typeof error.type === 'string'
  );
}

function describeError(error: unknown): { status: number; message: string } {
  switch (true) {
    case error instanceof z.ZodError:
      return { status: 400, message: error.issues.map(issue => issue.message).join('; ') };
    case error instanceof HttpError:
      return { status: error.status, message: error.message };
    case error instanceof SignatureCheckError:
      return { status: 400, message: error.message };
    case error instanceof OrderConflictError:
      return { status: 409, message: error.message };
    case error instanceof TransakError:
      console.error(`[transak] ${error.detail}`);
      return { status: 502, message: 'Checkout provider is not available. Try again later.' };
    case isBodyParserError(error) && error.status >= 400 && error.status < 500:
      return { status: error.status, message: 'Request body is not valid' };
    default:
      console.error('[server] Unexpected error', error);
      return { status: 500, message: 'Internal error' };
  }
}

/** Send each error as JSON: `{ error: string }`. */
export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const { status, message } = describeError(error);
  res.status(status).json({ error: message });
};
