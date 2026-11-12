import { getGuardianCommitmentFromAccount, getSignerDetailsFromAccount } from './account';
import { assertRecoverySignerMatches, readServedStateFacts, sameCommitment } from './recovery-verification';

jest.mock('lib/i18n', () => ({ getMessage: (key: string) => key }));
jest.mock('./account', () => ({
  getSignerDetailsFromAccount: jest.fn(),
  getGuardianCommitmentFromAccount: jest.fn()
}));

const signer = getSignerDetailsFromAccount as jest.Mock;
const guardian = getGuardianCommitmentFromAccount as jest.Mock;

const freed = { id: jest.fn(), nonce: jest.fn(), commitment: jest.fn() };

const account = () =>
  ({
    id: () => ({ toString: () => '0xid', free: freed.id }),
    nonce: () => ({ asInt: () => 7n, free: freed.nonce }),
    isNew: () => false,
    to_commitment: () => ({ toHex: () => '0xABCD', free: freed.commitment })
  }) as never;

describe('recovery verification', () => {
  beforeEach(() => jest.resetAllMocks());

  it('compares commitments ignoring prefix and case', () => {
    expect(sameCommitment('0xAaBb', 'aabb')).toBe(true);
    expect(sameCommitment('aabb', 'aabc')).toBe(false);
  });

  describe('assertRecoverySignerMatches', () => {
    it('passes an equal recovery slot', async () => {
      signer.mockResolvedValue({ commitment: 'aabb' });
      await expect(assertRecoverySignerMatches(account(), '0xAABB')).resolves.toBeUndefined();
      expect(signer).toHaveBeenCalledWith(expect.anything(), true);
    });

    it('refuses a different recovery slot', async () => {
      signer.mockResolvedValue({ commitment: 'ffff' });
      await expect(assertRecoverySignerMatches(account(), '0xAABB')).rejects.toMatchObject({
        code: 'GUARDIAN_RECOVERY_UNVERIFIED',
        message: 'guardianRecoveryUnverified'
      });
    });

    it('refuses an unreadable recovery slot', async () => {
      signer.mockRejectedValue(new Error('No signer commitment found in account storage'));
      await expect(assertRecoverySignerMatches(account(), '0xAABB')).rejects.toMatchObject({
        code: 'GUARDIAN_RECOVERY_UNVERIFIED'
      });
    });
  });

  describe('readServedStateFacts', () => {
    it('lower-cases and strips every readable slot', async () => {
      signer.mockImplementation(async (_acc: unknown, cold: boolean) => ({
        commitment: cold ? '0xCC' : 'HOT'
      }));
      guardian.mockReturnValue('0xGG');
      const bytes = new Uint8Array([1]);
      await expect(readServedStateFacts(account(), bytes)).resolves.toEqual({
        bytes,
        accountIdHex: '0xid',
        nonce: 7n,
        isNew: false,
        commitment: 'abcd',
        hotCommitment: 'hot',
        coldCommitment: 'cc',
        guardianCommitment: 'gg'
      });
    });

    it('frees the account id, nonce and commitment handles it reads', async () => {
      signer.mockResolvedValue({ commitment: 'aa' });
      await readServedStateFacts(account(), new Uint8Array());
      expect(freed.id).toHaveBeenCalledTimes(1);
      expect(freed.nonce).toHaveBeenCalledTimes(1);
      expect(freed.commitment).toHaveBeenCalledTimes(1);
    });

    it('rethrows a WebAssembly trap from a slot read instead of treating the slot as unreadable', async () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      signer.mockRejectedValue(trap);
      await expect(readServedStateFacts(account(), new Uint8Array())).rejects.toBe(trap);
      await expect(assertRecoverySignerMatches(account(), 'aa')).rejects.toBe(trap);
    });

    it('leaves a slot undefined when its reader throws', async () => {
      signer.mockRejectedValue(new Error('unreadable'));
      guardian.mockReturnValue(undefined);
      const facts = await readServedStateFacts(account(), new Uint8Array());
      expect(facts.hotCommitment).toBeUndefined();
      expect(facts.coldCommitment).toBeUndefined();
      expect(facts.guardianCommitment).toBeUndefined();
    });
  });
});
