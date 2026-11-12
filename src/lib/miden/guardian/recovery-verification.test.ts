import { getGuardianCommitmentFromAccount, getSignerDetailsFromAccount } from './account';
import { RPC_READ_TIMEOUT_MS, createNodeReads } from '../transaction/reconcile-reads';
import {
  assertRecoverySignerMatches,
  judgeServedState,
  readAccountChainState,
  readServedStateFacts,
  sameCommitment,
  selectAdoptable,
  type AccountChainState,
  type ServedGuardianState,
  type ServedStateVerdict
} from './recovery-verification';

jest.mock('lib/i18n', () => ({ getMessage: (key: string) => key }));
jest.mock('../transaction/reconcile-reads', () => ({
  RPC_READ_TIMEOUT_MS: 15000,
  createNodeReads: jest.fn()
}));
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
  describe('judgeServedState', () => {
    it.each<[string, boolean, string, AccountChainState, ServedStateVerdict]>([
      ['a new account the chain has not seen', true, 'ab', { kind: 'absent' }, 'undeployed'],
      ['a used account the chain has not seen', false, 'ab', { kind: 'absent' }, 'unverified'],
      [
        'a copy equal to the chain in any case or prefix',
        false,
        '0xAB',
        { kind: 'deployed', commitment: 'ab' },
        'verified'
      ],
      ['a copy that differs from the chain', false, 'ab', { kind: 'deployed', commitment: 'cd' }, 'mismatch'],
      ['a new copy of a deployed account', true, 'ab', { kind: 'deployed', commitment: 'cd' }, 'mismatch'],
      ['a chain that could not be read', false, 'ab', { kind: 'unknown' }, 'unknown']
    ])('%s', (_name, isNew, commitment, chain, verdict) => {
      expect(judgeServedState({ isNew, commitment }, chain)).toBe(verdict);
    });
  });

  describe('selectAdoptable', () => {
    const entry = (accountIdHex: string, verdict: Exclude<ServedStateVerdict, 'undeployed'>, tag = verdict) => ({
      state: { accountIdHex } as ServedGuardianState,
      verdict,
      tag
    });

    it('drops a stale copy when the same account has a copy equal to the chain', () => {
      const a = entry('0xa', 'verified', 'a1');
      const stale = entry('0xa', 'mismatch', 'a2');
      const b = entry('0xb', 'verified', 'b1');
      expect(selectAdoptable([a, stale, b])).toEqual([a, b]);
    });

    it('refuses with the behind-network copy when an account has only copies that differ from the chain', () => {
      expect(() => selectAdoptable([entry('0xa', 'verified'), entry('0xb', 'mismatch')])).toThrow(
        expect.objectContaining({ code: 'GUARDIAN_RECOVERY_UNVERIFIED', message: 'guardianRecoveryBehindNetwork' })
      );
    });

    it('refuses with the network copy when an account could not be read', () => {
      expect(() => selectAdoptable([entry('0xa', 'verified'), entry('0xb', 'unknown')])).toThrow(
        expect.objectContaining({
          code: 'GUARDIAN_RECOVERY_NETWORK_UNREACHABLE',
          message: 'guardianRecoveryNetworkUnreachable'
        })
      );
    });

    it('refuses when any copy reports transactions the chain has never seen, even beside a verified account', () => {
      expect(() => selectAdoptable([entry('0xa', 'verified'), entry('0xa', 'unverified')])).toThrow(
        expect.objectContaining({ code: 'GUARDIAN_RECOVERY_UNVERIFIED', message: 'guardianRecoveryUnverified' })
      );
    });
  });

  describe('readAccountChainState', () => {
    const read = (result: unknown) => {
      const account = jest.fn().mockResolvedValue(result);
      (createNodeReads as jest.Mock).mockResolvedValue({ account });
      return account;
    };

    it('reports a commitment as deployed, normalized', async () => {
      const account = read({ ok: true, state: { blockNum: 1, commitment: '0xAB' } });
      await expect(readAccountChainState('0xid')).resolves.toEqual({ kind: 'deployed', commitment: 'ab' });
      expect(account).toHaveBeenCalledWith('0xid', undefined, RPC_READ_TIMEOUT_MS);
    });

    it('reports no commitment as absent', async () => {
      read({ ok: true, state: { blockNum: 1 } });
      await expect(readAccountChainState('0xid')).resolves.toEqual({ kind: 'absent' });
    });

    it('reports notFound as absent', async () => {
      read({ ok: true, state: { blockNum: 1, notFound: true } });
      await expect(readAccountChainState('0xid')).resolves.toEqual({ kind: 'absent' });
    });

    it('reports a failed read as unknown', async () => {
      read({ ok: false, pruned: false, timedOut: true });
      await expect(readAccountChainState('0xid')).resolves.toEqual({ kind: 'unknown' });
    });

    it('reports a throw as unknown without rejecting', async () => {
      (createNodeReads as jest.Mock).mockRejectedValue(new Error('no rpc'));
      await expect(readAccountChainState('0xid')).resolves.toEqual({ kind: 'unknown' });
    });
  });
});
