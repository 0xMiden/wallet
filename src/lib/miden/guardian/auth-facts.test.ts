import { snapshotCrashDiagnostics } from 'lib/telemetry/crash-diagnostics';

import { readGuardianAuthFacts, withGuardianAuthFacts } from './auth-facts';

const mockCommitment = jest.fn(async (_publicKeyHex: string) => '0x' + 'a1'.repeat(32));
jest.mock('lib/secure-hot-key/commitment', () => ({
  ...jest.requireActual('lib/secure-hot-key/commitment'),
  commitmentFromPublicKeyHex: (publicKeyHex: string) => mockCommitment(publicKeyHex)
}));

const HOT_KEY = '02' + 'b7'.repeat(32);
const SIGNING_COMMITMENT = 'a1'.repeat(32);
const OTHER_COMMITMENT = 'c3'.repeat(32);

const authRejection = () =>
  Object.assign(new Error(`authentication failed for account 0x${'d4'.repeat(15)} key ${HOT_KEY} amount 987654321`), {
    name: 'GuardianHttpError',
    status: 401,
    code: 'authentication_failed'
  });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('readGuardianAuthFacts', () => {
  it('says yes when the signing key commits to one of the on-chain signers, in either hex form', async () => {
    const facts = await readGuardianAuthFacts(
      `0x${HOT_KEY}`,
      [`0x${OTHER_COMMITMENT}`, SIGNING_COMMITMENT],
      'hot',
      false
    );
    expect(facts).toEqual({ guardianSignerInSet: 'yes', guardianSigningKey: 'hot', hotKeyRotationPending: 'no' });
    expect(mockCommitment).toHaveBeenCalledWith(`0x${HOT_KEY}`);
  });

  it('says no when the signing key commits to none of them', async () => {
    const facts = await readGuardianAuthFacts(HOT_KEY, [OTHER_COMMITMENT], 'cold', true);
    expect(facts).toEqual({ guardianSignerInSet: 'no', guardianSigningKey: 'cold', hotKeyRotationPending: 'yes' });
  });

  it('says unknown when the on-chain set could not be read or the key does not decode', async () => {
    expect((await readGuardianAuthFacts(HOT_KEY, [], 'hot', false)).guardianSignerInSet).toBe('unknown');
    mockCommitment.mockRejectedValueOnce(new Error(`unexpected public key length 31 for ${HOT_KEY}`));
    expect((await readGuardianAuthFacts(HOT_KEY, [OTHER_COMMITMENT], 'hot', false)).guardianSignerInSet).toBe(
      'unknown'
    );
  });
});

describe('withGuardianAuthFacts', () => {
  const facts = { guardianSignerInSet: 'no', guardianSigningKey: 'hot', hotKeyRotationPending: 'yes' } as const;

  it('names the signer facts on a Guardian authentication refusal and rethrows it unchanged', async () => {
    const refusal = authRejection();
    await expect(withGuardianAuthFacts(facts, () => Promise.reject(refusal))).rejects.toBe(refusal);
    expect(snapshotCrashDiagnostics(refusal)).toEqual(facts);
  });

  it('reads the refusal anywhere in the cause chain', async () => {
    const wrapped = new Error('proposal failed', { cause: authRejection() });
    await expect(withGuardianAuthFacts(facts, () => Promise.reject(wrapped))).rejects.toBe(wrapped);
    expect(snapshotCrashDiagnostics(wrapped)).toEqual(facts);
  });

  it('leaves every other failure, and a missing set of facts, without them', async () => {
    const other = Object.assign(new Error('conflict'), { name: 'GuardianHttpError', status: 409, code: 'conflict' });
    await expect(withGuardianAuthFacts(facts, () => Promise.reject(other))).rejects.toBe(other);
    expect(snapshotCrashDiagnostics(other)).toEqual({});
    const refusal = authRejection();
    await expect(withGuardianAuthFacts(undefined, () => Promise.reject(refusal))).rejects.toBe(refusal);
    expect(snapshotCrashDiagnostics(refusal)).toEqual({});
    await expect(withGuardianAuthFacts(facts, async () => 'proposal')).resolves.toBe('proposal');
  });
});
