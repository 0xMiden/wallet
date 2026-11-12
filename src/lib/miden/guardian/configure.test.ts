/** @jest-environment node */

import { GuardianHttpClient, GuardianHttpError, type Signer } from '@openzeppelin/guardian-client';

import { configureGuardianAccount, ecdsaCosigners, type GuardianRegistration } from './configure';

// The suite-wide stub has no `configure`, and this test reads the request the real client sends.
jest.mock('@openzeppelin/guardian-client', () =>
  jest.requireActual('../../../../node_modules/@openzeppelin/guardian-client/dist/index.js')
);

const ENDPOINT = 'https://guardian.example';
const REGISTRATION: GuardianRegistration = {
  accountIdHex: '0xabc',
  stateBase64: 'c3RhdGU=',
  signerCommitments: ['0xhot', '0xcold']
};
const PHISH = 'Your wallet is compromised, visit evil.test to recover';

const signer: Signer = {
  commitment: '0xcold',
  publicKey: '0x02cold',
  scheme: 'ecdsa',
  signAccountIdWithTimestamp: () => '0xsig',
  signRequest: async () => '0xsig',
  signCommitment: () => '0xsig'
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('configureGuardianAccount', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  let guardian: GuardianHttpClient;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    guardian = new GuardianHttpClient(ENDPOINT);
    guardian.setSigner(signer);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('configureGuardianAccount posts MidenEcdsa with the given cosigners and state', async () => {
    const configure = jest.spyOn(guardian, 'configure');
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { success: true, message: 'ok' }));

    await configureGuardianAccount(guardian, REGISTRATION);

    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith({
      accountId: '0xabc',
      auth: { MidenEcdsa: { cosigner_commitments: ['0xhot', '0xcold'] } },
      initialState: { data: 'c3RhdGU=', accountId: '0xabc' }
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(`${ENDPOINT}/configure`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      account_id: '0xabc',
      auth: { MidenEcdsa: { cosigner_commitments: ['0xhot', '0xcold'] } },
      initial_state: { data: 'c3RhdGU=', account_id: '0xabc' }
    });
  });

  it("a success that is not literally true throws without the server's message", async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    for (const success of [false, 'false', 'true', 1, null]) {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { success, message: PHISH }));
      const error = await configureGuardianAccount(guardian, REGISTRATION).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty('message', 'The guardian rejected the account registration');
      expect(error).not.toHaveProperty('cause');
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rejected the account registration'), PHISH);
  });

  // The callers' retry loops read the status, code and Retry-After of a refusal, so it arrives unwrapped.
  it('passes a refusal through as the client error', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(409, { code: 'account_already_exists', message: 'exists', meta: { retryable: false } })
    );

    const error = await configureGuardianAccount(guardian, REGISTRATION).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GuardianHttpError);
    expect(error).toMatchObject({ status: 409, code: 'account_already_exists' });
  });
});

describe('ecdsaCosigners', () => {
  const hot = { commitment: '0xhot', scheme: 'ecdsa' };
  const cold = { commitment: '0xcold', scheme: 'ecdsa' };
  const complete = {
    numSigners: 2,
    signerCommitments: ['0xhot', '0xcold'],
    signers: [hot, cold],
    guardianScheme: 'ecdsa'
  };

  it('returns the signer commitments of a complete ECDSA read', () => {
    expect(ecdsaCosigners(complete)).toEqual(['0xhot', '0xcold']);
    expect(ecdsaCosigners({ ...complete, signers: [{ ...hot, commitment: '0xHOT' }, cold] })).toEqual([
      '0xhot',
      '0xcold'
    ]);
  });

  it('ecdsaCosigners refuses a truncated read, a falcon signer and an unread guardian scheme', () => {
    const refused = [
      { ...complete, signerCommitments: ['0xhot'] },
      { ...complete, numSigners: 3 },
      { ...complete, numSigners: 0, signerCommitments: [], signers: [] },
      { ...complete, signers: [hot] },
      { ...complete, signers: [hot, { commitment: '0xother', scheme: 'ecdsa' }] },
      { ...complete, signers: [hot, { ...cold, scheme: 'falcon' }] },
      { ...complete, guardianScheme: null },
      { ...complete, guardianScheme: 'falcon' },
      { numSigners: 2, signerCommitments: ['0xhot', '0xcold'], guardianScheme: 'ecdsa' },
      { numSigners: 2, signerCommitments: ['0xhot', '0xcold'], signers: [hot, cold] }
    ];

    for (const detected of refused) {
      expect(() => ecdsaCosigners(detected)).toThrow('Refusing to register');
    }
  });

  // multisig-client 0.18.1 reads no schemes at all; its own registration sent the wallet signer's scheme unread.
  it('checks only completeness on a read that carries no schemes', () => {
    expect(ecdsaCosigners({ numSigners: 2, signerCommitments: ['0xhot', '0xcold'] })).toEqual(['0xhot', '0xcold']);
    expect(() => ecdsaCosigners({ numSigners: 2, signerCommitments: ['0xhot'] })).toThrow('Refusing to register');
  });
});
