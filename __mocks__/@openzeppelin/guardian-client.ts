/**
 * Automatic mock for @openzeppelin/guardian-client.
 *
 * ESM package pulled in transitively by guardian/signer.ts and guardian/digest.ts.
 */

export class GuardianHttpClient {
  constructor(..._args: unknown[]) {}
  setSigner = jest.fn();
  getState = jest.fn();
  getPubkey = jest.fn();
}

export class GuardianHttpError extends Error {}

export class RequestAuthPayload {
  constructor(..._args: unknown[]) {}
  toWord = jest.fn(() => new Uint8Array(32));
}
