import type { ErrorBody, ErrorCode } from './types';

/** The fields that an error adds to the body, after `error` and `message`. */
export type ErrorExtra = Pick<ErrorBody, 'retryAfter' | 'id'>;

/** An error that maps to one API error response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly extra: ErrorExtra;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: ErrorExtra = {},
    headers: Record<string, string> = {}
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

export const invalidRequest = (message: string): ApiError => new ApiError(400, 'invalid_request', message);
export const tooLarge = (): ApiError => new ApiError(413, 'payload_too_large', 'The request body is too large.');
export const notFound = (): ApiError => new ApiError(404, 'not_found', 'The route does not exist.');
export const notConfigured = (): ApiError => new ApiError(503, 'service_unavailable', 'The service is not configured.');
