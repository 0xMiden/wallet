import type { ErrorCode } from './types';

/** An error that maps to one API error response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly extra: { salt?: string };
  readonly headers: Record<string, string>;

  /**
   * @param extra Fields to add to the body.
   */
  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: { salt?: string } = {},
    headers: Record<string, string> = {}
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

export const badRequest = (message: string): ApiError => new ApiError(400, 'bad_request', message);
export const unauthorized = (message: string): ApiError => new ApiError(401, 'unauthorized', message);
export const tooLarge = (message: string): ApiError => new ApiError(413, 'payload_too_large', message);
export const notConfigured = (): ApiError =>
  new ApiError(503, 'service_unavailable', 'The service is not configured.');
export const profileGone = (): ApiError => unauthorized('The profile does not exist. Log in again.');
