import { AccountInspector } from '@openzeppelin/miden-multisig-client';

import { deriveGuardianAccountSeed, rebuildGuardianAccount } from './account-recipe';
import { RPC_READ_TIMEOUT_MS, createNodeReads } from '../transaction/reconcile-reads';
import {
  assertRecoverySignerMatches,
  assertUndeployedStateFromSeed,
  judgeServedState,
  readAccountChainState,
  readAccountChainStates,
  readServedStateFacts,
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
jest.mock('@openzeppelin/miden-multisig-client', () => ({
  AccountInspector: { getSignerPublicKeyCommitments: jest.fn(), getGuardianPublicKeyCommitment: jest.fn() }
}));
jest.mock('./account-recipe', () => ({
  ...jest.requireActual('./account-recipe'),
  rebuildGuardianAccount: jest.fn()
}));
const mockLock = { held: 0, labels: new Array<string>(), revoked: false };
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>, options?: { label?: string }) => {
    mockLock.held++;
    mockLock.labels.push(options?.label ?? '');
    try {
      return await fn({});
    } finally {
      mockLock.held--;
    }
  },
  assertWasmHoldCurrent: (_hold: object, where: string) => {
    if (mockLock.revoked) throw new Error(`hold lost ${where}`);
  }
}));

// The slots are read through the inspector itself, so these drive what the recovery reads in production.
const signers = AccountInspector.getSignerPublicKeyCommitments as jest.Mock;
const guardian = AccountInspector.getGuardianPublicKeyCommitment as jest.Mock;

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

  describe('assertRecoverySignerMatches', () => {
    it('passes an equal recovery slot', async () => {
      const acc = account();
      signers.mockReturnValue(['hot', 'aabb']);
      await expect(assertRecoverySignerMatches(acc, '0xAABB')).resolves.toBeUndefined();
      expect(signers).toHaveBeenCalledWith(acc);
    });

    it('refuses a different recovery slot', async () => {
      signers.mockReturnValue(['hot', 'ffff']);
      await expect(assertRecoverySignerMatches(account(), '0xAABB')).rejects.toMatchObject({
        code: 'GUARDIAN_RECOVERY_UNVERIFIED',
        message: 'guardianRecoveryUnverified'
      });
    });

    it.each([
      [
        'an unreadable',
        () =>
          signers.mockImplementation(() => {
            throw new Error('not a guarded multisig');
          })
      ],
      ['a missing', () => signers.mockReturnValue(['hot'])],
      ['an all-zero', () => signers.mockReturnValue(['hot', `0x${'0'.repeat(64)}`])]
    ])('refuses %s recovery slot', async (_name, arrange) => {
      arrange();
      await expect(assertRecoverySignerMatches(account(), `0x${'0'.repeat(64)}`)).rejects.toMatchObject({
        code: 'GUARDIAN_RECOVERY_UNVERIFIED'
      });
    });
  });

  describe('readServedStateFacts', () => {
    it('lower-cases and strips every readable slot', async () => {
      signers.mockReturnValue(['HOT', '0xCC']);
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
      signers.mockReturnValue(['aa', 'bb']);
      await readServedStateFacts(account(), new Uint8Array());
      expect(freed.id).toHaveBeenCalledTimes(1);
      expect(freed.nonce).toHaveBeenCalledTimes(1);
      expect(freed.commitment).toHaveBeenCalledTimes(1);
    });

    it('rethrows a WebAssembly trap from the signer read instead of treating the slot as unreadable', async () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      signers.mockImplementation(() => {
        throw trap;
      });
      await expect(readServedStateFacts(account(), new Uint8Array())).rejects.toBe(trap);
      await expect(assertRecoverySignerMatches(account(), 'aa')).rejects.toBe(trap);
    });

    it('rethrows a WebAssembly trap from the guardian read instead of treating the slot as unreadable', async () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      signers.mockReturnValue(['aa', 'bb']);
      guardian.mockImplementation(() => {
        throw trap;
      });
      await expect(readServedStateFacts(account(), new Uint8Array())).rejects.toBe(trap);
    });

    it('leaves a slot undefined when the inspector throws, has no entry, or reads an all-zero word', async () => {
      signers.mockImplementation(() => {
        throw new Error('unreadable');
      });
      guardian.mockImplementation(() => {
        throw new Error('missing guardian commitment');
      });
      const unreadable = await readServedStateFacts(account(), new Uint8Array());
      expect(unreadable.hotCommitment).toBeUndefined();
      expect(unreadable.coldCommitment).toBeUndefined();
      expect(unreadable.guardianCommitment).toBeUndefined();

      signers.mockReturnValue([`0x${'0'.repeat(64)}`]);
      guardian.mockReturnValue(undefined);
      const empty = await readServedStateFacts(account(), new Uint8Array());
      expect(empty.hotCommitment).toBeUndefined();
      expect(empty.coldCommitment).toBeUndefined();
      expect(empty.guardianCommitment).toBeUndefined();
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
      [
        'a copy equal to the chain once leading zeros are dropped',
        false,
        'abc123',
        { kind: 'deployed', commitment: `${'0'.repeat(40)}abc123` },
        'verified'
      ],
      ['a copy one digit away from the chain', false, 'abc123', { kind: 'deployed', commitment: 'abc124' }, 'mismatch'],
      ['a new copy of a deployed account', true, 'ab', { kind: 'deployed', commitment: 'cd' }, 'mismatch'],
      ['a chain that could not be read', false, 'ab', { kind: 'unknown' }, 'unknown']
    ])('%s', (_name, isNew, commitment, chain, verdict) => {
      expect(judgeServedState({ isNew, commitment }, chain)).toBe(verdict);
    });
  });

  describe('selectAdoptable', () => {
    const servedState = (accountIdHex: string): ServedGuardianState => ({
      bytes: new Uint8Array(),
      accountIdHex,
      nonce: 1n,
      isNew: false,
      commitment: 'ab'
    });
    const entry = (
      accountIdHex: string,
      verdict: Exclude<ServedStateVerdict, 'undeployed'>,
      tag: string = verdict
    ) => ({
      state: servedState(accountIdHex),
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

  describe('assertUndeployedStateFromSeed', () => {
    const rebuild = jest.mocked(rebuildGuardianAccount);
    const coldSeed = new Uint8Array(32).fill(7);
    const hot = 'aa'.repeat(32);
    const guardianKey = 'bb'.repeat(32);
    const served = (overrides: Partial<ServedGuardianState> = {}): ServedGuardianState => ({
      bytes: new Uint8Array(),
      accountIdHex: '0xacc',
      nonce: 0n,
      isNew: true,
      commitment: 'abcd',
      hotCommitment: hot,
      coldCommitment: 'cc',
      guardianCommitment: guardianKey,
      ...overrides
    });
    const same = { accountIdHex: '0xacc', commitment: '0xABCD' };
    const otherId = { accountIdHex: '0xother', commitment: 'abcd' };
    const refusal = { code: 'GUARDIAN_RECOVERY_UNVERIFIED', message: 'guardianRecoveryUnverified' };

    beforeEach(() => {
      mockLock.held = 0;
      mockLock.labels = [];
      mockLock.revoked = false;
    });

    it('refuses a served account with no readable hot slot, rebuilding nothing', async () => {
      await expect(
        assertUndeployedStateFromSeed(served({ hotCommitment: undefined }), coldSeed, '0xcold')
      ).rejects.toMatchObject(refusal);
      expect(rebuild).not.toHaveBeenCalled();
    });

    it('refuses a served account with no readable guardian slot, rebuilding nothing', async () => {
      await expect(
        assertUndeployedStateFromSeed(served({ guardianCommitment: undefined }), coldSeed, '0xcold')
      ).rejects.toMatchObject(refusal);
      expect(rebuild).not.toHaveBeenCalled();
    });

    it('passes when the rebuild from the derived account seed matches, making no legacy rebuild', async () => {
      rebuild.mockResolvedValue(same);

      await expect(assertUndeployedStateFromSeed(served(), coldSeed, '0xcold')).resolves.toBeUndefined();
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(rebuild).toHaveBeenCalledWith({
        hotCommitment: hot,
        coldCommitment: '0xcold',
        guardianCommitment: guardianKey,
        initSeed: await deriveGuardianAccountSeed(coldSeed, hot, guardianKey)
      });
    });

    it('passes when only the legacy rebuild from the recovery seed itself matches', async () => {
      rebuild.mockResolvedValueOnce(otherId).mockResolvedValueOnce(same);

      await expect(assertUndeployedStateFromSeed(served(), coldSeed, '0xcold')).resolves.toBeUndefined();
      expect(rebuild).toHaveBeenCalledTimes(2);
      expect(rebuild.mock.calls[1]?.[0]).toEqual({
        hotCommitment: hot,
        coldCommitment: '0xcold',
        guardianCommitment: guardianKey,
        initSeed: coldSeed
      });
    });

    it('refuses a served key commitment that is not 32-byte hex, rebuilding nothing', async () => {
      await expect(
        assertUndeployedStateFromSeed(served({ hotCommitment: 'aa' }), coldSeed, '0xcold')
      ).rejects.toMatchObject(refusal);
      expect(rebuild).not.toHaveBeenCalled();
    });

    it('refuses a served account the builder will not build, such as an everyday key equal to the recovery key', async () => {
      rebuild.mockRejectedValue(new Error(`duplicate signer commitment: 0x${hot}`));

      await expect(assertUndeployedStateFromSeed(served(), coldSeed, `0x${hot}`)).rejects.toMatchObject(refusal);
      expect(rebuild).toHaveBeenCalledTimes(1);
    });

    it('refuses when neither rebuild has the served id', async () => {
      rebuild.mockResolvedValue(otherId);

      await expect(assertUndeployedStateFromSeed(served(), coldSeed, '0xcold')).rejects.toMatchObject(refusal);
      expect(rebuild).toHaveBeenCalledTimes(2);
    });

    it('refuses a rebuild with the same id and a different commitment', async () => {
      rebuild.mockResolvedValue({ accountIdHex: '0xacc', commitment: 'ffff' });

      await expect(assertUndeployedStateFromSeed(served(), coldSeed, '0xcold')).rejects.toMatchObject(refusal);
    });

    it('rebuilds under the recover-guardian-rebuild hold', async () => {
      rebuild.mockImplementation(async () => {
        if (mockLock.held === 0) throw new Error('rebuilt with no WASM lock hold');
        return otherId;
      });

      await expect(assertUndeployedStateFromSeed(served(), coldSeed, '0xcold')).rejects.toMatchObject(refusal);
      expect(mockLock.labels).toEqual(['recover-guardian-rebuild']);
    });

    it('stops before the legacy rebuild once the hold is lost', async () => {
      rebuild.mockImplementation(async () => {
        mockLock.revoked = true;
        return otherId;
      });

      await expect(assertUndeployedStateFromSeed(served(), coldSeed, '0xcold')).rejects.toThrow('hold lost');
      expect(rebuild).toHaveBeenCalledTimes(1);
    });

    it('rethrows a WebAssembly trap from the rebuild', async () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      rebuild.mockRejectedValue(trap);

      await expect(assertUndeployedStateFromSeed(served(), coldSeed, '0xcold')).rejects.toBe(trap);
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

  describe('readAccountChainStates', () => {
    it('reads every id on one client, with both reads in flight together', async () => {
      const pending: Array<{ id: string; settle: (read: unknown) => void }> = [];
      const account = jest.fn(
        (id: string) =>
          new Promise(settle => {
            pending.push({ id, settle });
          })
      );
      (createNodeReads as jest.Mock).mockResolvedValue({ account });

      const reading = readAccountChainStates(['0xa', '0xb']);
      for (let tick = 0; tick < 50 && pending.length < 2; tick++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      expect(createNodeReads).toHaveBeenCalledTimes(1);
      expect(pending.map(read => read.id)).toEqual(['0xa', '0xb']);
      expect(account).toHaveBeenCalledWith('0xa', undefined, RPC_READ_TIMEOUT_MS);
      expect(account).toHaveBeenCalledWith('0xb', undefined, RPC_READ_TIMEOUT_MS);
      for (const read of pending) {
        read.settle({ ok: true, state: { blockNum: 1, commitment: read.id === '0xa' ? '0xAB' : '0xCD' } });
      }
      await expect(reading).resolves.toEqual(
        new Map<string, AccountChainState>([
          ['0xa', { kind: 'deployed', commitment: 'ab' }],
          ['0xb', { kind: 'deployed', commitment: 'cd' }]
        ])
      );
    });

    it('returns an empty map without a client when there are no ids', async () => {
      await expect(readAccountChainStates([])).resolves.toEqual(new Map());
      expect(createNodeReads).not.toHaveBeenCalled();
    });

    it('reads a duplicated id once and maps a failed read to unknown', async () => {
      const account = jest.fn(async (id: string) => {
        if (id === '0xb') throw new Error('rpc');
        return { ok: true, state: { blockNum: 1, commitment: '0xAB' } };
      });
      (createNodeReads as jest.Mock).mockResolvedValue({ account });

      await expect(readAccountChainStates(['0xa', '0xb', '0xa'])).resolves.toEqual(
        new Map<string, AccountChainState>([
          ['0xa', { kind: 'deployed', commitment: 'ab' }],
          ['0xb', { kind: 'unknown' }]
        ])
      );
      expect(createNodeReads).toHaveBeenCalledTimes(1);
      expect(account.mock.calls.map(call => call[0])).toEqual(['0xa', '0xb']);
    });
  });
});
