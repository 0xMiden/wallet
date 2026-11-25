// Types of the bindings, the request context and the wire shapes. The D1 row types are in rows.ts.

export type Feature = 'accounts' | 'contacts' | 'history';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'nonce_invalid'
  | 'signature_invalid'
  | 'salt_not_set'
  | 'salt_already_set'
  | 'unknown_feature'
  | 'payload_too_large'
  | 'entry_limit'
  | 'not_found'
  | 'forbidden'
  | 'rate_limited'
  | 'service_unavailable'
  | 'internal_error';

/**
 * The Worker bindings. Wrangler can deploy a Worker without a binding or a secret,
 * so each one is optional and the code checks it. /healthz reports a missing one.
 */
export interface Env {
  DB?: D1Database;
  /** Per caller address, on the nonce and login routes. */
  AUTH_RATE_LIMIT?: RateLimit;
  /** Per profile, on every authenticated route. Reads and writes count on separate keys. */
  STORAGE_RATE_LIMIT?: RateLimit;
  ALLOWED_ORIGINS?: string;
  DEPLOYMENT_REVISION?: string;
  JWT_SIGNING_KEY?: string;
}

export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  now: () => number;
}

export type Handler = (context: RequestContext) => Response | Promise<Response>;

/** The page of a feature read: the inclusive `since` cursor, the key the page starts after, and its size. */
export interface ReadPage {
  since: number | null;
  after: string | null;
  limit: number;
}

// ---------------------------------------------------------------- wire shapes

export interface ErrorBody {
  error: ErrorCode;
  message: string;
  salt?: string;
}

export interface HealthResponse {
  ok: boolean;
  revision: string;
}

export interface NonceRequest {
  publicKey: string;
}

export interface NonceResponse {
  nonce: string;
  expiresAt: number;
}

export interface LoginRequest {
  publicKey: string;
  message: string;
  signature: string;
  /** The nonce hex that the message carries. */
  nonce: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  profileId: string;
  salt: string | null;
}

export interface SaltRequest {
  salt: string;
}

export interface SaltResponse {
  salt: string;
}

/** The encrypted entry on the wire, in both directions. */
export interface EncryptedEntry {
  envelope: number;
  kdfParams: number;
  blob: string;
}

/** An encrypted entry after validation, with the blob decoded. */
export interface DecodedEntry {
  envelope: number;
  kdfParams: number;
  blob: Uint8Array;
}

export interface BatchItem {
  hashedKey: string;
  entry: DecodedEntry;
}

export interface EntryView {
  hashedKey: string;
  revision: number;
  updatedAt: number;
  entry: EncryptedEntry;
}

export interface WriteAck {
  hashedKey: string;
  revision: number;
  updatedAt: number;
}

export interface FeatureRead {
  /** The ETag of the complete feature, the same on every page of one read when nothing was written between them. */
  etag: string;
  entries: EntryView[];
  /** The hashed key the next page starts after, or null on the last page. */
  next: string | null;
}

export interface StorageRead {
  etag: string;
  features: Record<Feature, { etag: string }>;
}

export interface BatchWriteResponse {
  entries: WriteAck[];
}

export interface TokenClaims {
  sub: string;
  pk: string;
  /** The profile generation the token was issued for. */
  gen: string;
  iat: number;
  exp: number;
}

export interface Principal {
  profileId: string;
  publicKey: string;
  /** The profile generation of the token, in lowercase hex. Every read and write checks it. */
  generation: string;
}
