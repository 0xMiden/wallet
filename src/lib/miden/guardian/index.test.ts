/**
 * MultisigService — wraps MultisigClient/Multisig/GuardianHttpClient into a
 * narrower surface used by the wallet. These tests cover:
 *   - constructor / accountId getter
 *   - proposal builders (send, consume, custom)
 *   - signAndExecute / signAndCreateTransactionRequest
 *   - sync retry on "nonce too low", including exhaustion
 *   - importAccountFromGuardian happy + error path
 *   - createSwitchGuardianProposal + finalizeGuardianSwitch
 *
 * All external collaborators are stubbed to keep tests hermetic.
 */

import { MultisigService } from './index';

const mockFetchFromStorage = jest.fn();
jest.mock('../front/storage', () => ({
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args)
}));

jest.mock('lib/settings/constants', () => ({
  GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting'
}));

jest.mock('lib/shared/helpers', () => ({
  u8ToB64: jest.fn(() => 'base64-bytes'),
  b64ToU8: jest.fn(() => new Uint8Array([1, 2, 3]))
}));

// Keep accountIdStringToSdk simple — we only assert it was called with the
// inputs we passed; the real implementation parses bech32 which needs WASM.
const mockAccountIdStringToSdk = jest.fn((id: string) => ({ toString: () => `sdk(${id})` }));
jest.mock('../sdk/helpers', () => ({
  accountIdStringToSdk: (...args: unknown[]) => mockAccountIdStringToSdk(...(args as [string]))
}));

const mockGetAccount = jest.fn();
const mockSyncState = jest.fn(async () => {});
const mockRawWebClient = { kind: 'raw-web-client' };
const mockMidenClient = {
  getAccount: (...args: unknown[]) => mockGetAccount(...args),
  syncState: () => mockSyncState(),
  client: mockRawWebClient
};
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => mockMidenClient,
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn()
}));

const mockInterfaceClient = { accounts: { insert: jest.fn(async () => {}) } };
jest.mock('../sdk/miden-client-interface', () => ({
  MidenClientInterface: {
    create: jest.fn(async () => ({ client: mockInterfaceClient }))
  }
}));

// Guardian SDK stubs — each constructor pulls from a per-test config so the
// same `new GuardianHttpClient(...)` call can return different behavior per
// test without juggling prototypes.
const guardianConfig: {
  getPubkey: jest.Mock;
  getState: jest.Mock;
  setSigner: jest.Mock;
} = {
  getPubkey: jest.fn(),
  getState: jest.fn(),
  setSigner: jest.fn()
};
const multisigClientConfig: { load: jest.Mock } = {
  load: jest.fn()
};

const mockBuildUpdateSignersTransactionRequest = jest.fn(async (..._args: unknown[]) => ({
  request: { kind: 'request' },
  salt: { toHex: () => 'salt-hex' }
}));
const mockExecuteForSummary = jest.fn(async (..._args: unknown[]) => ({
  serialize: () => new Uint8Array([0xab])
}));

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  GuardianHttpClient: jest.fn().mockImplementation(() => ({
    getPubkey: (...a: unknown[]) => guardianConfig.getPubkey(...a),
    getState: (...a: unknown[]) => guardianConfig.getState(...a),
    setSigner: (...a: unknown[]) => guardianConfig.setSigner(...a)
  })),
  MultisigClient: jest.fn().mockImplementation(() => ({
    load: (...a: unknown[]) => multisigClientConfig.load(...a)
  })),
  buildUpdateSignersTransactionRequest: (...a: unknown[]) => mockBuildUpdateSignersTransactionRequest(...a),
  executeForSummary: (...a: unknown[]) => mockExecuteForSummary(...a)
}));

const mockGenerateHotKey = jest.fn();
const mockSignHotDigest = jest.fn();
const mockDeleteHotKey = jest.fn();
jest.mock('lib/secure-hot-key', () => ({
  generateHotKey: (...a: unknown[]) => mockGenerateHotKey(...a),
  signHotDigest: (...a: unknown[]) => mockSignHotDigest(...a),
  deleteHotKey: (...a: unknown[]) => mockDeleteHotKey(...a)
}));

const mockGetSignerDetailsFromAccount = jest.fn();
jest.mock('./account', () => ({
  getSignerDetailsFromAccount: (...a: unknown[]) => mockGetSignerDetailsFromAccount(...a),
  // Resolve to the per-account endpoint, falling back to the stored value the
  // fetchFromStorage mock returns — mirrors the real resolveGuardianEndpoint.
  resolveGuardianEndpoint: async (acc: { guardianEndpoint?: string }) =>
    acc.guardianEndpoint ?? 'https://stored.guardian.test'
}));

// atob is globally available on Node 16+ but jsdom stubs can vary — provide
// a deterministic polyfill for these tests.
if (typeof global.atob === 'undefined') {
  global.atob = (str: string) => Buffer.from(str, 'base64').toString('binary');
}

// Augment the existing wasmMock with the one bit we need: Account.deserialize.
const mockAccountDeserialize = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    Account: {
      ...(actual.Account ?? {}),
      deserialize: (...args: unknown[]) => mockAccountDeserialize(...args)
    }
  };
});
jest.mock('@miden-sdk/miden-sdk', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    Account: {
      ...(actual.Account ?? {}),
      deserialize: (...args: unknown[]) => mockAccountDeserialize(...args)
    }
  };
});

const makeMultisig = (overrides: Partial<Record<string, unknown>> = {}) => ({
  accountId: 'acc-id',
  account: {
    nonce: () => ({ asInt: () => 5n })
  },
  threshold: 1,
  getEffectiveThreshold: jest.fn(() => 1),
  createP2idProposal: jest.fn(async () => ({ kind: 'p2id' })),
  createConsumeNotesProposal: jest.fn(async () => ({ kind: 'consume' })),
  createProposal: jest.fn(async () => ({ kind: 'custom', id: 'proposal-id' })),
  createTransactionProposalRequest: jest.fn(async () => 'tx-req'),
  signProposal: jest.fn(async () => ({ signatures: [] })),
  abandonCandidate: jest.fn(async () => ({ state: 'pending' })),
  executeProposal: jest.fn(async () => {}),
  syncState: jest.fn(async () => {}),
  getConsumableNotes: jest.fn(async () => ['note-a']),
  createSwitchGuardianProposal: jest.fn(async () => ({
    nonce: 7,
    txSummary: 'txs-b64',
    metadata: { proposalType: 'switch-guardian' }
  })),
  setGuardianClient: jest.fn(),
  registerOnGuardian: jest.fn(async () => {}),
  guardianPublicKey: 'old-pubkey',
  ...overrides
});

describe('MultisigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchFromStorage.mockResolvedValue('https://stored.guardian.test');
  });

  describe('constructor + getters', () => {
    it('accountId delegates to the wrapped Multisig', () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      expect(service.accountId).toBe('acc-id');
      expect(service.guardianEndpoint).toBe('https://x');
    });

    it('getAuthInfo reports threshold, signer set, and procedure thresholds', () => {
      const multisig = makeMultisig({
        threshold: 1,
        signerCommitments: ['0xhot', '0xcold'],
        procedureThresholds: new Map<string, number>([['update_guardian', 2]])
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const auth = service.getAuthInfo();
      expect(auth.threshold).toBe(1);
      expect(auth.signerCommitments).toEqual(['0xhot', '0xcold']);
      expect(auth.procedureThresholds).toEqual({ update_guardian: 2 });
    });

    it('getAuthInfo degrades gracefully when the multisig lacks fields', () => {
      const multisig = makeMultisig(); // no signerCommitments / procedureThresholds
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const auth = service.getAuthInfo();
      expect(auth.signerCommitments).toEqual([]);
      expect(auth.procedureThresholds).toEqual({});
    });

    it('getProcedureThreshold reads the procedure map', () => {
      const multisig = makeMultisig({ procedureThresholds: new Map<string, number>([['update_guardian', 2]]) });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      expect(service.getProcedureThreshold('update_guardian')).toBe(2);
      expect(service.getProcedureThreshold('nope')).toBeUndefined();
    });
  });

  describe('proposal builders', () => {
    it('createSendProposal normalizes recipient+faucet ids through accountIdStringToSdk', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const proposal = await service.createSendProposal('rec', 'fauc', 1000n);

      expect(multisig.createP2idProposal).toHaveBeenCalledWith('sdk(rec)', 'sdk(fauc)', 1000n);
      expect(proposal).toEqual({ kind: 'p2id' });
    });

    it('createConsumeNotesProposal forwards note ids untouched', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const proposal = await service.createConsumeNotesProposal(['n1', 'n2']);

      expect(multisig.createConsumeNotesProposal).toHaveBeenCalledWith(['n1', 'n2']);
      expect(proposal).toEqual({ kind: 'consume' });
    });

    it('createUpdateProcedureThresholdProposal forwards the procedure and threshold', async () => {
      const createUpdateFn = jest.fn(async () => ({ kind: 'update-threshold' }));
      const multisig = makeMultisig({ createUpdateProcedureThresholdProposal: createUpdateFn });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const proposal = await service.createUpdateProcedureThresholdProposal('update_guardian', 2);

      expect(createUpdateFn).toHaveBeenCalledWith('update_guardian', 2);
      expect(proposal).toEqual({ kind: 'update-threshold' });
    });

    it('createCustomProposal forwards request bytes and proposal type', async () => {
      const createCustomFn = jest.fn(async () => ({ kind: 'custom' }));
      const multisig = makeMultisig({ createCustomProposal: createCustomFn });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const bytes = new Uint8Array([1, 2, 3]);

      const proposal = await service.createCustomProposal(bytes, 'my-type');

      expect(createCustomFn).toHaveBeenCalledWith(bytes, 'my-type');
      expect(proposal).toEqual({ kind: 'custom' });
    });
  });

  describe('signing helpers', () => {
    it('signAndExecuteProposal signs then executes a given proposal', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await service.signAndExecuteProposal('p-1');

      expect(multisig.signProposal).toHaveBeenCalledWith('p-1');
      expect(multisig.executeProposal).toHaveBeenCalledWith('p-1');
    });

    it('signAndCreateTransactionRequest signs then returns the request payload', async () => {
      // Non-custom proposal → the normal createTransactionProposalRequest path.
      const multisig = makeMultisig({
        signProposal: jest.fn(async () => ({ metadata: { proposalType: 'send' } }))
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const tx = await service.signAndCreateTransactionRequest('p-2');

      expect(multisig.signProposal).toHaveBeenCalledWith('p-2');
      expect(multisig.createTransactionProposalRequest).toHaveBeenCalledWith('p-2');
      expect(tx).toBe('tx-req');
    });

    it('signAndCreateTransactionRequest rejects a custom proposal with no request bytes', async () => {
      const multisig = makeMultisig({
        signProposal: jest.fn(async () => ({ metadata: { proposalType: 'custom' } }))
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await expect(service.signAndCreateTransactionRequest('p-custom')).rejects.toThrow(
        'Request Bytes are required for custom execution'
      );
    });

    it('abandonCandidate forwards the candidate nonce to the Guardian SDK', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await service.abandonCandidate(7);

      expect(multisig.abandonCandidate).toHaveBeenCalledWith(7);
    });

    it('getConsumableNotes forwards to the wrapped Multisig', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await expect(service.getConsumableNotes()).resolves.toEqual(['note-a']);
    });
  });

  describe('sync retry logic', () => {
    it('resets retry count after a successful sync', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      service.syncRetryCount = 4;

      await service.sync();

      expect(service.syncRetryCount).toBe(0);
    });

    it('rethrows immediately for non-nonce errors', async () => {
      const multisig = makeMultisig({ syncState: jest.fn(async () => Promise.reject(new Error('network down'))) });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await expect(service.sync()).rejects.toThrow('network down');
    });

    it('throws "Max sync retries reached" after MAX_SYNC_RETRIES consecutive nonce-too-low failures', async () => {
      const origSetTimeout = global.setTimeout;
      (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      const nonceErr = new Error('nonce is too low');
      const syncState = jest.fn(async () => {
        throw nonceErr;
      });
      const multisig = makeMultisig({ syncState });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      try {
        await expect(service.sync()).rejects.toThrow('Max sync retries reached');
        // 30 retries + the initial attempt = 31 calls.
        expect(syncState).toHaveBeenCalledTimes(31);
      } finally {
        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
      }
    });

    it('increments the retry counter on a nonce-too-low error', async () => {
      // Short-circuit the wait between retries so the test doesn't sit on a real 3s timer.
      const origSetTimeout = global.setTimeout;
      (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      const multisig = makeMultisig({
        syncState: jest.fn().mockRejectedValueOnce(new Error('nonce is too low')).mockResolvedValueOnce(undefined)
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      try {
        await service.sync();
        // After the retry succeeds, the counter resets to 0 again.
        expect(service.syncRetryCount).toBe(0);
        expect(multisig.syncState).toHaveBeenCalledTimes(2);
      } finally {
        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
      }
    });

    it('waits out a canonicalizing guardian without re-registering, then the retried sync succeeds', async () => {
      // "Refusing to overwrite local state" means the guardian is mid-canonicalization
      // (its blob briefly lags on-chain). It's transient, so we WAIT and retry — we must
      // NOT re-register on the first sign (that re-`configure`s the old guardian after a
      // switch and strands the account).
      const origSetTimeout = global.setTimeout;
      (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      const syncState = jest
        .fn()
        .mockRejectedValueOnce(
          new Error('Refusing to overwrite local state: incoming commitment does not match on-chain commitment')
        )
        .mockResolvedValueOnce(undefined);
      const registerOnGuardian = jest.fn(async () => {});
      const multisig = makeMultisig({ syncState, registerOnGuardian });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([1, 2, 3]) });

      try {
        await service.sync();
        expect(registerOnGuardian).not.toHaveBeenCalled(); // waited, did not re-register
        expect(syncState).toHaveBeenCalledTimes(2); // initial + one retry
      } finally {
        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
      }
    });

    it('re-registers once as a last resort after the canonicalization window, then the retried sync succeeds', async () => {
      // Only after the bounded wait is exhausted do we treat the lag as a genuine
      // divergence and re-register the current on-chain state once, then retry.
      const origSetTimeout = global.setTimeout;
      (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      // 30 waited retries, then the 31st failure exhausts the window and
      // re-registers; the 32nd attempt succeeds.
      let calls = 0;
      const syncState = jest.fn(async () => {
        calls++;
        if (calls <= 31) {
          throw new Error('Refusing to overwrite local state');
        }
      });
      const registerOnGuardian = jest.fn(async () => {});
      const multisig = makeMultisig({ syncState, registerOnGuardian });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([1, 2, 3]) });

      try {
        await service.sync();
        expect(registerOnGuardian).toHaveBeenCalledTimes(1); // last-resort re-register, once
        expect(syncState).toHaveBeenCalledTimes(32); // 31 lag failures + 1 success after re-register
      } finally {
        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
      }
    });
  });

  describe('reRegisterCurrentStateOnGuardian', () => {
    it('syncs, serializes the current account, and re-registers it on the guardian', async () => {
      const registerOnGuardian = jest.fn(async () => {});
      const multisig = makeMultisig({ registerOnGuardian });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue({ serialize: () => new Uint8Array([0xaa, 0xbb]) });

      await service.reRegisterCurrentStateOnGuardian();

      expect(mockSyncState).toHaveBeenCalled();
      expect(registerOnGuardian).toHaveBeenCalledTimes(1);
    });

    it('throws when the account is missing from the local client', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      mockGetAccount.mockResolvedValue(null);

      await expect(service.reRegisterCurrentStateOnGuardian()).rejects.toThrow('missing from local client');
    });
  });

  describe('importAccountFromGuardian', () => {
    const signWordFn = jest.fn(async () => 'sig');

    beforeEach(() => {
      guardianConfig.setSigner.mockReset();
      guardianConfig.getState.mockReset();
    });

    it('fetches state, base64-decodes into Account, and inserts into the webClient', async () => {
      const webClient = {
        accounts: { insert: jest.fn(async () => {}) }
      };
      const stateBase64 = Buffer.from('hello').toString('base64');
      guardianConfig.getState.mockResolvedValueOnce({ stateJson: { data: stateBase64 } });
      const fakeAccount = { id: () => ({ toString: () => 'acc-id' }) };
      mockAccountDeserialize.mockReturnValueOnce(fakeAccount);

      await MultisigService.importAccountFromGuardian('pub', 'commit', signWordFn, 'acc-id', webClient as never);

      expect(guardianConfig.setSigner).toHaveBeenCalled();
      expect(mockAccountDeserialize).toHaveBeenCalled();
      expect(webClient.accounts.insert).toHaveBeenCalledWith({ account: fakeAccount, overwrite: true });
    });

    it('rejects (and does not insert) when the guardian returns a mismatched account id', async () => {
      const webClient = { accounts: { insert: jest.fn(async () => {}) } };
      const stateBase64 = Buffer.from('evil').toString('base64');
      guardianConfig.getState.mockResolvedValueOnce({ stateJson: { data: stateBase64 } });
      mockAccountDeserialize.mockReturnValueOnce({ id: () => ({ toString: () => 'attacker-acc' }) });

      await expect(
        MultisigService.importAccountFromGuardian('pub', 'commit', signWordFn, 'acc-id', webClient as never)
      ).rejects.toThrow('Guardian returned account attacker-acc but acc-id was requested');
      expect(webClient.accounts.insert).not.toHaveBeenCalled();
    });

    it('re-throws when the guardian state fetch fails', async () => {
      const webClient = { accounts: { insert: jest.fn() } };
      guardianConfig.getState.mockRejectedValueOnce(new Error('404'));

      await expect(
        MultisigService.importAccountFromGuardian('pub', 'commit', signWordFn, 'acc-id', webClient as never)
      ).rejects.toThrow('404');
      expect(webClient.accounts.insert).not.toHaveBeenCalled();
    });

    it('falls back to DEFAULT_GUARDIAN_ENDPOINT when storage has no URL', async () => {
      // Exercises the `|| DEFAULT_GUARDIAN_ENDPOINT` branch on the endpoint lookup.
      const webClient = { accounts: { insert: jest.fn(async () => {}) } };
      mockFetchFromStorage.mockResolvedValueOnce(undefined);
      const stateBase64 = Buffer.from('hi').toString('base64');
      guardianConfig.getState.mockResolvedValueOnce({ stateJson: { data: stateBase64 } });
      mockAccountDeserialize.mockReturnValueOnce({ id: () => ({ toString: () => 'acc-id' }) });

      await MultisigService.importAccountFromGuardian('pub', 'commit', signWordFn, 'acc-id', webClient as never);

      expect(webClient.accounts.insert).toHaveBeenCalled();
    });
  });

  describe('init', () => {
    it('loads the Multisig for an existing account and binds the passed endpoint', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      const loaded = makeMultisig();
      multisigClientConfig.load.mockResolvedValueOnce(loaded);

      const svc = await MultisigService.init(account, 'pub', 'commit', async () => 'sig', 'https://acct.guardian');

      expect(svc).toBeInstanceOf(MultisigService);
      expect(svc.multisig).toBe(loaded);
      // Endpoint is supplied by the caller (per-account), not read from storage.
      expect(svc.guardianEndpoint).toBe('https://acct.guardian');
    });

    it('re-throws when MultisigClient.load rejects', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      multisigClientConfig.load.mockRejectedValueOnce(new Error('load failed'));

      await expect(
        MultisigService.init(account, 'pub', 'commit', async () => 'sig', 'https://acct.guardian')
      ).rejects.toThrow('load failed');
    });
  });

  describe('guardian switch', () => {
    it('createSwitchGuardianProposal consults the new guardian for its commitment and builds the proposal', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: 'new-commit', pubkey: 'new-pubkey' });

      const { newEndpoint } = await service.createSwitchGuardianProposal('https://new');

      expect(newEndpoint).toBe('https://new');
      expect(multisig.createSwitchGuardianProposal).toHaveBeenCalledWith('https://new', 'new-commit');
      // `createSwitchGuardianProposal` already creates the proposal — it must NOT
      // be re-created via the generic `createProposal` (that would duplicate it).
      expect(multisig.createProposal).not.toHaveBeenCalled();
    });

    it('createSwitchGuardianProposal re-throws when the new guardian fetch fails', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      guardianConfig.getPubkey.mockRejectedValueOnce(new Error('unreachable'));

      await expect(service.createSwitchGuardianProposal('https://new')).rejects.toThrow('unreachable');
    });

    it('finalizeGuardianSwitch serializes post-switch state and re-registers with the new guardian', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: 'new-commit', pubkey: 'new-pubkey' });

      await service.finalizeGuardianSwitch('https://new');

      expect(mockSyncState).toHaveBeenCalled();
      expect(multisig.setGuardianClient).toHaveBeenCalled();
      expect(multisig.guardianPublicKey).toBe('new-commit');
      expect(service.guardianEndpoint).toBe('https://new');
      expect(multisig.registerOnGuardian).toHaveBeenCalledWith('base64-bytes');
    });

    it('finalizeGuardianSwitch throws when the SDK has no record of the switched account', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce(null);

      await expect(service.finalizeGuardianSwitch('https://new')).rejects.toThrow(
        `Updated account acc-id is missing from local client`
      );
      expect(multisig.registerOnGuardian).not.toHaveBeenCalled();
    });

    it('finalizeGuardianSwitch retries a transient registration failure then succeeds', async () => {
      const origSetTimeout = global.setTimeout;
      (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      const multisig = makeMultisig({
        registerOnGuardian: jest.fn().mockRejectedValueOnce(new Error('guardian down')).mockResolvedValueOnce(undefined)
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: 'new-commit', pubkey: 'new-pubkey' });

      try {
        await service.finalizeGuardianSwitch('https://new');
        expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(2);
      } finally {
        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
      }
    });

    it('finalizeGuardianSwitch throws after exhausting registration retries', async () => {
      const origSetTimeout = global.setTimeout;
      (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      const multisig = makeMultisig({
        registerOnGuardian: jest.fn(async () => Promise.reject(new Error('guardian down')))
      });
      const service = new MultisigService(multisig as never, {} as never, 'https://old');
      mockGetAccount.mockResolvedValueOnce({ serialize: () => new Uint8Array([1]) });
      guardianConfig.getPubkey.mockResolvedValueOnce({ commitment: 'new-commit', pubkey: 'new-pubkey' });

      try {
        await expect(service.finalizeGuardianSwitch('https://new')).rejects.toThrow(
          'Failed to register account on the new guardian after switching'
        );
        // MAX_GUARDIAN_REGISTER_RETRIES attempts.
        expect(multisig.registerOnGuardian).toHaveBeenCalledTimes(5);
      } finally {
        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
      }
    });
  });

  describe('signProposal pass-through', () => {
    it('forwards signProposal to the wrapped Multisig and does not finalize the proposal', async () => {
      const multisig = makeMultisig();
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      await service.signProposal('p-3');

      expect(multisig.signProposal).toHaveBeenCalledWith('p-3');
      expect(multisig.executeProposal).not.toHaveBeenCalled();
      expect(multisig.createTransactionProposalRequest).not.toHaveBeenCalled();
    });
  });

  describe('buildColdMultisigService', () => {
    it('reads the cold commitment from on-chain via getSignerDetailsFromAccount(_, true) and inits a service with cold pubkey', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      const walletAccount = { publicKey: 'acc-id', coldPublicKey: 'cold-pub' } as never;
      const loaded = makeMultisig();
      multisigClientConfig.load.mockResolvedValueOnce(loaded);
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'cold-commit-no-prefix' });

      const signWordFn = jest.fn(async () => 'sig');
      const svc = await MultisigService.buildColdMultisigService(account, walletAccount, signWordFn);

      expect(mockGetSignerDetailsFromAccount).toHaveBeenCalledWith(account, true);
      expect(svc).toBeInstanceOf(MultisigService);
      // The service initialized via init forwards the COLD pubkey/commitment
      // (each prefixed with 0x) to the WalletSigner. We can't introspect that
      // directly here, so we assert load was called — proving init proceeded.
      expect(multisigClientConfig.load).toHaveBeenCalledWith('acc-id', expect.anything());
      // Endpoint is resolved per-account (here falling back to the stored value).
      expect(svc.guardianEndpoint).toBe('https://stored.guardian.test');
    });

    it('throws when the WalletAccount has no coldPublicKey', async () => {
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;
      const walletAccount = { publicKey: 'acc-id' } as never; // missing coldPublicKey
      const signWordFn = jest.fn(async () => 'sig');

      await expect(MultisigService.buildColdMultisigService(account, walletAccount, signWordFn)).rejects.toThrow(
        /missing coldPublicKey/
      );
      expect(multisigClientConfig.load).not.toHaveBeenCalled();
    });
  });

  describe('createReplaceHotKeyProposal', () => {
    it('mints a fresh hot key and builds a single-proposal swap with target list [newHot, cold]', async () => {
      const multisig = makeMultisig({ threshold: 1 });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const account = { id: () => ({ toString: () => 'acc-id' }) } as never;

      mockGenerateHotKey.mockResolvedValueOnce({
        ciphertext: 'new-hot-cipher',
        publicKeyHex: 'new-hot-pub',
        commitmentHex: '0xnewhotcommit'
      });
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'coldcommitnoprefix' });

      const result = await service.createReplaceHotKeyProposal(account);

      expect(mockGenerateHotKey).toHaveBeenCalled();
      expect(mockGetSignerDetailsFromAccount).toHaveBeenCalledWith(account, true);
      // Order preservation: newHot at index 0, cold at index 1.
      expect(mockBuildUpdateSignersTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        1,
        ['0xnewhotcommit', '0xcoldcommitnoprefix'],
        { signatureScheme: 'ecdsa', midenRpcEndpoint: expect.any(String) }
      );
      expect(mockExecuteForSummary).toHaveBeenCalledWith(
        expect.anything(),
        'acc-id',
        { kind: 'request' },
        expect.any(String)
      );
      // Proposal label is cosmetic; on-chain effect is dictated by targetSignerCommitments.
      expect(multisig.createProposal).toHaveBeenCalledWith(
        expect.any(Number),
        'base64-bytes',
        expect.objectContaining({
          proposalType: 'add_signer',
          targetThreshold: 1,
          targetSignerCommitments: ['0xnewhotcommit', '0xcoldcommitnoprefix'],
          saltHex: 'salt-hex'
        })
      );
      expect(result.newHot).toEqual({
        ciphertext: 'new-hot-cipher',
        publicKeyHex: 'new-hot-pub',
        commitmentHex: '0xnewhotcommit'
      });
      expect(result.proposal).toEqual({ kind: 'custom', id: 'proposal-id' });
    });

    it('handles secureHotKey commitments without 0x prefix by adding it', async () => {
      // Defensive: not all commitment producers may prefix. We normalize.
      const multisig = makeMultisig({ threshold: 1 });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');
      const account = { id: () => 'acc-id' } as never;

      mockGenerateHotKey.mockResolvedValueOnce({
        ciphertext: 'cx',
        publicKeyHex: 'pk',
        commitmentHex: 'newhotnoprefix' // intentionally unprefixed
      });
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: 'coldnoprefix' });

      await service.createReplaceHotKeyProposal(account);

      expect(mockBuildUpdateSignersTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        1,
        ['0xnewhotnoprefix', '0xcoldnoprefix'],
        { signatureScheme: 'ecdsa', midenRpcEndpoint: expect.any(String) }
      );
    });
  });

  describe('sync de-duplication', () => {
    it('coalesces overlapping sync() calls onto a single in-flight run', async () => {
      let resolveSync: () => void = () => {};
      const syncState = jest.fn(
        () =>
          new Promise<void>(resolve => {
            resolveSync = resolve;
          })
      );
      const multisig = makeMultisig({ syncState });
      const service = new MultisigService(multisig as never, {} as never, 'https://x');

      const first = service.sync();
      const second = service.sync();
      expect(first).toBe(second); // second tick reuses the in-flight promise

      resolveSync();
      await first;
      expect(syncState).toHaveBeenCalledTimes(1);

      // After settling, a fresh call starts a new run.
      const third = service.sync();
      expect(third).not.toBe(first);
      resolveSync();
      await third;
      expect(syncState).toHaveBeenCalledTimes(2);
    });
  });
});
