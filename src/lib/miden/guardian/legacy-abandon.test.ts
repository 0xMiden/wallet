/** @jest-environment node */

import { GuardianHttpError, RequestAuthPayload } from '@openzeppelin/guardian-client';

import { abandonCandidateByNonce } from './legacy-abandon';

// The suite-wide stub neither canonicalizes request payloads nor parses error bodies, and this request depends on both.
jest.mock('@openzeppelin/guardian-client', () =>
  jest.requireActual('../../../../node_modules/@openzeppelin/guardian-client/dist/index.js')
);

const ENDPOINT = 'https://guardian.example';
const PUBKEY = '0x02aabb';
const NONCE_ONLY_BODY = '{"account_id":"0xabc","nonce":7}';

const makeSigner = () => ({
  publicKey: PUBKEY,
  signRequest: jest.fn(async (_accountId: string, _timestamp: number, _payload: RequestAuthPayload) => '0xsig')
});

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const accepted = (extra: Record<string, unknown> = {}) =>
  jsonResponse(202, { account_id: '0xabc', nonce: 7, state: 'pending', abandon_requested_at: 'now', ...extra });

const refusal = (status: number, code: string, headers: Record<string, string> = {}) =>
  jsonResponse(status, { code, message: 'refused', meta: { retryable: false } }, headers);

describe('abandonCandidateByNonce', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const sentHeaders = (call: number) => new Headers(fetchSpy.mock.calls[call]?.[1]?.headers);

  it('posts the nonce-only body signed over exactly that body', async () => {
    fetchSpy.mockResolvedValue(accepted());
    const signer = makeSigner();

    await abandonCandidateByNonce(ENDPOINT, signer, '0xabc', 7);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${ENDPOINT}/delta/candidate/abandon`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(NONCE_ONLY_BODY);
    const headers = sentHeaders(0);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-pubkey')).toBe(PUBKEY);
    expect(headers.get('x-signature')).toBe('0xsig');
    expect(headers.get('x-timestamp')).toMatch(/^\d+$/);
    expect(signer.signRequest).toHaveBeenCalledTimes(1);
    const [accountId, timestamp, payload] = signer.signRequest.mock.calls[0]!;
    expect(accountId).toBe('0xabc');
    expect(timestamp).toBe(Number(headers.get('x-timestamp')));
    expect(payload).toBeInstanceOf(RequestAuthPayload);
    expect(payload.toCanonicalJson()).toBe(NONCE_ONLY_BODY);
  });

  it('returns the commitment a 0.19 Guardian names and none from 0.18', async () => {
    fetchSpy.mockResolvedValueOnce(accepted({ commitment: '0xc0ffee' }));
    await expect(abandonCandidateByNonce(ENDPOINT, makeSigner(), '0xabc', 7)).resolves.toEqual({
      commitment: '0xc0ffee'
    });

    fetchSpy.mockResolvedValueOnce(accepted());
    const legacy = await abandonCandidateByNonce(ENDPOINT, makeSigner(), '0xabc', 7);
    expect(legacy.commitment).toBeUndefined();
  });

  it('throws a GuardianHttpError carrying status and code', async () => {
    fetchSpy.mockResolvedValue(refusal(409, 'GUARDIAN_CANDIDATE_LANDED', { 'Retry-After': '5' }));

    const error: unknown = await abandonCandidateByNonce(ENDPOINT, makeSigner(), '0xabc', 7).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GuardianHttpError);
    expect(error).toMatchObject({ status: 409, code: 'candidate_landed' });
    expect(error instanceof GuardianHttpError && error.retryAfterSecs()).toBe(5);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries once with a later timestamp on authentication_replay', async () => {
    fetchSpy.mockResolvedValueOnce(refusal(401, 'authentication_replay')).mockResolvedValueOnce(accepted());
    const signer = makeSigner();

    await expect(abandonCandidateByNonce(ENDPOINT, signer, '0xabc', 7)).resolves.toEqual({});

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(Number(sentHeaders(1).get('x-timestamp'))).toBeGreaterThan(Number(sentHeaders(0).get('x-timestamp')));
    expect(signer.signRequest).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[1]?.body).toBe(NONCE_ONLY_BODY);
  });

  it('throws a second replay without a third request', async () => {
    fetchSpy
      .mockResolvedValueOnce(refusal(401, 'authentication_replay'))
      .mockResolvedValueOnce(refusal(401, 'authentication_replay'));

    await expect(abandonCandidateByNonce(ENDPOINT, makeSigner(), '0xabc', 7)).rejects.toMatchObject({
      status: 401,
      code: 'authentication_replay'
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
