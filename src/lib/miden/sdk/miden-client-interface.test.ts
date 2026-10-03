import { installHiddenDocument, type HiddenDocument } from 'lib/mobile/testing/hidden-document';

import { APPLY_RETRY_DELAYS_MS } from './apply-after-submit';
import type { WasmLockHold } from './miden-client';

type MidenClientInterfaceType = import('./miden-client-interface').MidenClientInterface;
// The shared native-HTTP recorder (guardian/__mocks__/native-http), the instance the code under test imported.
const requireProbes = () =>
  jest.requireMock<typeof import('../guardian/__mocks__/native-http')>('../guardian/native-http');

/** Never the mutex owner, so a catch handed it can never retire anything. */
const NO_HOLD = {} as unknown as WasmLockHold;

describe('MidenClientInterface', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const fakeTransactionResult = {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'tx-hex' }),
      outputNotes: () => ({ notes: () => [] }),
      inputNotes: () => ({ notes: () => [] })
    }),
    serialize: () => new Uint8Array([7])
  };

  function buildFakeMidenClient(overrides: Record<string, any> = {}) {
    return {
      accounts: {
        create: jest.fn(async () => ({ id: () => 'id' })),
        get: jest.fn(async () => 'acc'),
        list: jest.fn(async () => ['acc']),
        import: jest.fn(async () => ({ id: () => 'id' })),
        ...overrides.accounts
      },
      notes: {
        list: jest.fn(async () => [
          {
            id: () => ({ toString: () => 'note-1' }),
            metadata: () => ({
              noteType: () => 'type',
              sender: () => 'sender'
            }),
            nullifier: () => 'nullifier',
            state: () => 'state',
            details: () => ({
              assets: () => ({
                fungibleAssets: () => [
                  {
                    amount: () => ({ toString: () => '10' }),
                    faucetId: () => 'faucet'
                  }
                ]
              })
            })
          }
        ]),
        listAvailable: jest.fn(async () => []),
        import: jest.fn(async () => 'note'),
        export: jest.fn(async () => ({ serialize: () => new Uint8Array([1]) })),
        sendPrivateOutput: jest.fn(async () => undefined),
        ...overrides.notes
      },
      transactions: {
        send: jest.fn(async () => ({ txId: 'tx-id', result: fakeTransactionResult })),
        consume: jest.fn(async () => ({ txId: 'tx-id', result: fakeTransactionResult })),
        submit: jest.fn(async () => ({ txId: 'tx-id', result: fakeTransactionResult })),
        // Staged pipeline used by the non-offscreen send path:
        // executeRequest → prove → submit → apply.
        executeRequest: jest.fn(async () => ({
          id: 'tx-id',
          result: fakeTransactionResult,
          prove: jest.fn(async () => ({
            submit: jest.fn(async () => ({ apply: jest.fn(async () => undefined) }))
          }))
        })),
        list: jest.fn(async () => [
          { accountId: () => 'id', serialize: () => new Uint8Array([9]) },
          { accountId: () => 'other', serialize: () => new Uint8Array([9]) }
        ]),
        waitFor: jest.fn(async () => {}),
        ...overrides.transactions
      },
      // The non-offscreen send reads the sender's account through the inner raw client, for the
      // vault key that carries the outgoing asset's callback flag, and builds its request with
      // `buildSendTransactionRequest`; without `getAccount` the send path throws. The staged consume
      // reads its notes and builds its request here too (#1233).
      _withInnerWebClient: jest.fn(async (fn: (inner: any) => Promise<any>) =>
        fn(
          overrides.__inner ?? {
            getAccount: jest.fn(async () => ({ vault: jest.fn() })),
            getInputNote: jest.fn(async (id: string) => ({ toNote: () => ({ note: id }) })),
            newConsumeTransactionRequest: jest.fn(async () => ({ serialize: () => new Uint8Array([8]) }))
          }
        )
      ),
      sync: jest.fn(async () => ({ blockNum: () => 5 })),
      getSyncHeight: jest.fn(async () => 5),
      storeIdentifier: jest.fn(() => 'test-store'),
      terminate: jest.fn(),
      defaultProver: null,
      ...overrides
    };
  }

  /**
   * A staged write as the fake client runs it (#1233): every attempt's `prove` runs `onProve` with
   * the options it was given, and a proof submits and applies.
   */
  function stagedExecuteRequest(onProve: (options?: { prover?: unknown }) => void | Promise<void> = () => {}) {
    const apply = jest.fn(async () => undefined);
    const submit = jest.fn(async () => ({ apply }));
    const prove = jest.fn(async (options?: { prover?: unknown }) => {
      await onProve(options);
      return { submit };
    });
    const executeRequest = jest.fn(async (_account: unknown, _request: unknown) => ({
      id: 'tx-id',
      result: fakeTransactionResult,
      prove
    }));
    return { executeRequest, prove, submit, apply };
  }

  /** The SDK and id helpers a staged consume or swap reaches, stubbed for a test account id (#1233). */
  function mockStagedSdk(sdk: Record<string, unknown> = {}) {
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      TransactionProver: { newLocalProver: jest.fn(() => 'local') },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      ...sdk
    }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) })),
      buildPswapCreateRequest: jest.fn(() => ({ kind: 'pswap', serialize: () => new Uint8Array([4]) })),
      buildConsumeTransactionRequest: jest.fn(() => ({ kind: 'consume', serialize: () => new Uint8Array([7]) }))
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));
  }

  /**
   * Settles a write whose apply may fail after its submit, with the apply retry's waits run on fake
   * timers so they cost no real time (#1233). Resolves to the write's result or its rejection.
   */
  async function settleThroughApplyRetry(write: () => Promise<unknown>): Promise<unknown> {
    jest.useFakeTimers();
    try {
      const settled = write().catch((caught: unknown) => caught);
      await jest.advanceTimersByTimeAsync(APPLY_RETRY_DELAYS_MS.reduce((total, ms) => total + ms, 0));
      return await settled;
    } finally {
      jest.useRealTimers();
    }
  }

  it('creates a client with provided callbacks', async () => {
    const fakeMidenClient = buildFakeMidenClient();
    const createMock = jest.fn(async () => fakeMidenClient);

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      MidenClient: { create: createMock, createMock: jest.fn() },
      NoteFile: { deserialize: jest.fn(() => ({})) },
      AccountFile: { deserialize: jest.fn(() => ({})) },
      NoteExportFormat: { Id: 'Id', Full: 'Full', Details: 'Details' },
      NoteType: { Private: 'Private', Public: 'Public' },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      TransactionProver: {
        newRemoteProver: jest.fn(() => 'remote'),
        newLocalProver: jest.fn(() => 'local')
      },
      getWasmOrThrow: jest.fn(async () => ({
        AccountId: {
          fromHex: jest.fn((id: string) => id),
          fromBech32: jest.fn((id: string) => id)
        },
        NoteType: { Public: 'public', Private: 'private' }
      })),
      WasmWebClient: {
        createClient: jest.fn(async () => ({
          getConsumableNotes: jest.fn(async () => []),
          terminate: jest.fn()
        }))
      },
      exportStore: jest.fn(async () => '{"version":1,"data":"dump"}'),
      importStore: jest.fn()
    }));
    jest.doMock('lib/miden-chain/effective-endpoints', () => ({
      getEffectiveNetworkName: () => 'localnet',
      getEffectiveRpcUrl: () => 'rpc-local',
      getEffectiveProverUrl: () => undefined,
      getEffectiveNoteTransportUrl: () => undefined
    }));
    jest.doMock('./constants', () => ({ NoteExportType: {} }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) })),
      buildConsumeTransactionRequest: jest.fn(() => ({ kind: 'consume', serialize: () => new Uint8Array([7]) }))
    }));
    jest.doMock('../helpers', () => ({
      // Real `isPrivateNoteType`: it is the note-type validation under test on
      // the send paths below, so stubbing it would make those assertions vacuous.
      ...jest.requireActual('../helpers'),
      getNoteRecallableAtMs: jest.fn(() => undefined),
      toNoteType: jest.fn()
    }));
    jest.doMock('../db/types', () => ({
      ConsumeTransaction: class {},
      SendTransaction: class {}
    }));
    jest.doMock('screens/onboarding/types', () => ({
      WalletType: { OnChain: 'on-chain', OffChain: 'off-chain' }
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const insertKeyCallback = jest.fn();
    const client = await MidenClientInterface.create({
      seed: new Uint8Array([1, 2, 3]),
      insertKeyCallback
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcUrl: 'rpc-local',
        seed: expect.any(Uint8Array),
        keystore: expect.objectContaining({
          insertKey: insertKeyCallback
        })
      })
    );

    // smoke a few methods
    await client.createMidenWallet('on-chain' as any, new Uint8Array([4]));
    await client.importPublicMidenWalletFromSeed(new Uint8Array([5]));
    await client.importNoteBytes(new Uint8Array([1, 2]), NO_HOLD);
    await client.getInputNoteDetails();
    await client.getConsumableNotes('id');
    await client.exportNote('note', {} as any);
    await client.getTransactionsForAccount('id');
    await client.exportDb();
    await client.importDb('{"version":1,"data":"dump"}');
    await client.sendTransaction(
      {
        accountId: 'id',
        amount: BigInt(1),
        secondaryAccountId: 'recip',
        faucetId: 'faucet',
        noteType: 'public' as any,
        type: 'send',
        extraInputs: { recallBlocks: 1 },
        status: 0,
        initiatedAt: Math.floor(Date.now() / 1000),
        displayIcon: 'SEND'
      } as any,
      600
    );
    await client.consumeNoteId(
      {
        accountId: 'id',
        noteId: 'note',
        faucetId: 'f',
        type: 'consume'
      } as any,
      600
    );
    await client.newTransaction('acc-id', new Uint8Array([1, 2]));

    // Freed last: a disposed client refuses to submit a write (#1233).
    client.free();
    expect(client.client.terminate).toBeDefined();
  });

  describe('the SDK observation sink', () => {
    /**
     * Every option `MidenClientInterface.create` may pass. Pinned as an exact
     * set rather than as a set of `objectContaining` assertions, because the
     * property that matters here is an ABSENCE: the SDK's high-fidelity
     * observation channel is opt-in at construction, and the wallet's promise
     * is that it never asks for it. A guard naming that flag would itself
     * break `guarantees.test.ts`, which forbids the name anywhere in `src`.
     * An exact key set forbids it — and anything else new — without naming it.
     */
    const CREATE_OPTION_KEYS = ['keystore', 'noteTransportUrl', 'observer', 'proverUrl', 'rpcUrl', 'seed', 'useWorker'];

    async function createAndCaptureOptions() {
      const createMock = jest.fn(async (_options: Record<string, unknown>) => buildFakeMidenClient());
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        MidenClient: { create: createMock, createMock: jest.fn() },
        TransactionProver: { newLocalProver: jest.fn(() => 'local') }
      }));
      jest.doMock('lib/miden-chain/effective-endpoints', () => ({
        getEffectiveNetworkName: () => 'localnet',
        getEffectiveRpcUrl: () => 'rpc-local',
        getEffectiveProverUrl: () => undefined,
        getEffectiveNoteTransportUrl: () => undefined
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      await MidenClientInterface.create({});
      const options: Record<string, unknown> = createMock.mock.calls[0]?.[0] ?? {};
      return options;
    }

    it('registers an observer at client construction', async () => {
      expect(typeof (await createAndCaptureOptions()).observer).toBe('function');
    });

    it('passes exactly the options it means to, so no observation flag can be added unnoticed', async () => {
      expect(Object.keys(await createAndCaptureOptions()).sort()).toEqual(CREATE_OPTION_KEYS);
    });

    /**
     * Drive a delegated consume whose prove reports one SDK prove step, the way the real client
     * does inside a staged consume's prove (#1233). Returns the prove ring so the caller can assert
     * what the attempt collected.
     */
    async function runProveWithObservation(options: { failFirstCall?: boolean } = {}) {
      mockStagedSdk();
      const proveTelemetry = await import('./prove-telemetry');
      proveTelemetry.__resetProveTelemetryForTest();

      let call = 0;
      const staged = stagedExecuteRequest(() => {
        call++;
        const failed = options.failFirstCall === true && call === 1;
        proveTelemetry.recordSdkProveStep({ durationMs: failed ? 8_000 : 2_000, failed });
        if (failed) throw new Error('remote prover unreachable');
      });

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(
        buildFakeMidenClient({ transactions: { executeRequest: staged.executeRequest } }) as any,
        'net'
      );
      await client.consumeNoteId(
        {
          accountId: 'acc-id',
          noteId: 'note-1',
          type: 'consume',
          delegateTransaction: true
        } as any,
        600
      );

      return proveTelemetry;
    }

    it('attributes the SDK-measured prove step to the wallet prove attempt around it', async () => {
      const proveTelemetry = await runProveWithObservation();
      const ring = proveTelemetry.getProveTelemetry();

      expect(ring).toHaveLength(1);
      expect(ring[0]?.proveStepMs).toBe(2_000);
      expect(ring[0]?.proveStepFailed).toBeUndefined();
    });

    it('sums both prove steps across a delegate failure and its local re-prove', async () => {
      const proveTelemetry = await runProveWithObservation({ failFirstCall: true });
      const ring = proveTelemetry.getProveTelemetry();

      expect(ring).toHaveLength(1);
      expect(ring[0]?.fellBack).toBe(true);
      expect(ring[0]?.proveStepMs).toBe(10_000);
      expect(ring[0]?.proveStepFailed).toBe(true);
    });

    it('closes the attempt when the prove throws, so a later step is not attributed to it', async () => {
      mockStagedSdk();

      const proveTelemetry = await import('./prove-telemetry');
      proveTelemetry.__resetProveTelemetryForTest();

      const staged = stagedExecuteRequest(() => {
        throw new Error('note has already been consumed');
      });
      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(
        buildFakeMidenClient({ transactions: { executeRequest: staged.executeRequest } }) as any,
        'net'
      );

      await expect(
        client.consumeNoteId({ accountId: 'a', noteId: 'n', type: 'consume', delegateTransaction: false } as any, 600)
      ).rejects.toThrow('note has already been consumed');

      // Had the failed attempt been left open, this step would arrive in an
      // ambiguous two-attempt window and be dropped rather than attributed.
      const next = proveTelemetry.beginProveAttempt();
      proveTelemetry.recordSdkProveStep({ durationMs: 5_000, failed: false });
      const entry = next.record({ path: 'local', durationMs: 10, fellBack: false });
      expect(entry?.proveStepMs).toBe(5_000);
    });
  });

  it('creates client from existing MidenClient using fromClient', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    expect(client.network).toBe('testnet');
    expect(client.client).toBe(fakeMidenClient);

    // Test passthrough methods
    await client.getAccount('acc-id');
    expect(fakeMidenClient.accounts.get).toHaveBeenCalled();

    await client.getAccounts();
    expect(fakeMidenClient.accounts.list).toHaveBeenCalled();

    await client.getInputNotes();
    expect(fakeMidenClient.notes.list).toHaveBeenCalled();

    await client.syncState();
    expect(fakeMidenClient.sync).toHaveBeenCalled();

    await client.importAccountById('acc-123');
    expect(fakeMidenClient.accounts.import).toHaveBeenCalled();
  });

  it('uses the SDK available-note listing for mock clients', async () => {
    const availableNote = { id: 'available-note' };
    const fakeMidenClient = buildFakeMidenClient({
      notes: {
        listAvailable: jest.fn(async () => [availableNote])
      }
    });

    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client: MidenClientInterfaceType = Reflect.apply(MidenClientInterface.fromClient, MidenClientInterface, [
      fakeMidenClient,
      'mock'
    ]);

    await expect(client.getConsumableNotes('mock-account')).resolves.toEqual([availableNote]);
    expect(fakeMidenClient.notes.listAvailable).toHaveBeenCalledWith({ account: 'mock-account' });
  });

  it('getInputNoteDetails skips partial notes whose id() is undefined', async () => {
    const fakeMidenClient = buildFakeMidenClient();
    // A partial (metadata-less) record: id() returns undefined until sync
    // completes the note. It must be filtered out, not crash the mapper.
    fakeMidenClient.notes.list = jest.fn(
      async (): Promise<any[]> => [
        { id: () => undefined, nullifier: () => undefined },
        {
          id: () => ({ toString: () => 'note-2' }),
          metadata: () => ({
            noteType: () => 'type',
            sender: () => 'sender'
          }),
          nullifier: () => 'nullifier',
          state: () => 'state',
          details: () => ({
            assets: () => ({
              fungibleAssets: () => []
            })
          })
        }
      ]
    );

    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const details = await client.getInputNoteDetails();
    expect(details).toHaveLength(1);
    expect(details[0]?.noteId).toBe('note-2');
  });

  it('imports wallet from bytes', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      AccountFile: { deserialize: jest.fn(() => ({})) }
    }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.importMidenWallet(new Uint8Array([1, 2, 3]));
    expect(result).toBe('id');
    expect(fakeMidenClient.accounts.import).toHaveBeenCalled();
  });

  it('exports a serialized account file through the supported SDK account export path', async () => {
    const accountFile = {
      authSecretKeyCount: jest.fn(() => 1),
      serialize: jest.fn(() => new Uint8Array([4, 5, 6])),
      free: jest.fn()
    };
    const fakeMidenClient = buildFakeMidenClient({
      accounts: { export: jest.fn(async () => accountFile) }
    });
    const assertLive = jest.fn();

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await expect(client.exportAccountFile('mtst1account_suffix', assertLive)).resolves.toEqual(
      new Uint8Array([4, 5, 6])
    );
    expect(fakeMidenClient.accounts.export).toHaveBeenCalledWith('sdk-mtst1account');
    expect(assertLive).toHaveBeenCalledWith('after account export');
    expect(accountFile.authSecretKeyCount).toHaveBeenCalledTimes(1);
    expect(accountFile.serialize).toHaveBeenCalledTimes(1);
    expect(accountFile.free).toHaveBeenCalledTimes(1);
  });

  it('reduces a hex-form composite id through the canonical helper, not a bare underscore split', async () => {
    const accountFile = {
      authSecretKeyCount: jest.fn(() => 1),
      serialize: jest.fn(() => new Uint8Array([4, 5, 6])),
      free: jest.fn()
    };
    const fakeMidenClient = buildFakeMidenClient({
      accounts: { export: jest.fn(async () => accountFile) }
    });

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await client.exportAccountFile('0x1234abcd_suffix');

    // A bare split would hand the SDK '0x1234abcd' unchanged; the helper canonicalizes it.
    expect(fakeMidenClient.accounts.export).toHaveBeenCalledWith('sdk-0x1234abcd');
  });

  it('refuses an account file with no authentication secret key and frees it', async () => {
    const accountFile = {
      authSecretKeyCount: jest.fn(() => 0),
      serialize: jest.fn(),
      free: jest.fn()
    };
    const fakeMidenClient = buildFakeMidenClient({
      accounts: { export: jest.fn(async () => accountFile) }
    });

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const { PublicError: PublicErrorClass } = await import('lib/miden/back/defaults');
    const refusal = await client.exportAccountFile('mtst1account').catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(PublicErrorClass);
    expect((refusal as Error).message).toBe('Account file does not contain an authentication secret key');
    expect(accountFile.serialize).not.toHaveBeenCalled();
    expect(accountFile.free).toHaveBeenCalledTimes(1);
  });

  it('refuses an account file carrying more keys than the one account being exported', async () => {
    // The vault reader refuses the commitments it can name; this is the backstop for the ones it
    // cannot, so a file can never fold in a key the user never acknowledged exporting.
    const accountFile = {
      authSecretKeyCount: jest.fn(() => 2),
      serialize: jest.fn(),
      free: jest.fn()
    };
    const fakeMidenClient = buildFakeMidenClient({
      accounts: { export: jest.fn(async () => accountFile) }
    });

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    // PublicError specifically: Vault.withError preserves only that class, so a bare Error would
    // reach the user as the generic 'Failed to export account file' instead of this reason.
    // One invocation, both assertions, so the free() count below still measures one export.
    const { PublicError } = await import('lib/miden/back/defaults');
    const refusal = await client.exportAccountFile('mtst1account').catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(PublicError);
    expect((refusal as Error).message).toBe('Account file contains 2 authentication secret keys, expected exactly one');
    expect(accountFile.serialize).not.toHaveBeenCalled();
    expect(accountFile.free).toHaveBeenCalledTimes(1);
  });

  it('keeps the unwinding error when releasing the account file also fails', async () => {
    // free() runs on the path assertLive may just have proved abandoned, where the handle belongs
    // to a client somebody else now owns. A throw there must not replace the real cause.
    const accountFile = {
      authSecretKeyCount: jest.fn(() => 1),
      serialize: jest.fn(),
      free: jest.fn(() => {
        throw new Error('free failed');
      })
    };
    const fakeMidenClient = buildFakeMidenClient({
      accounts: { export: jest.fn(async () => accountFile) }
    });
    const assertLive = jest.fn(() => {
      throw new Error('export-account-file abandoned');
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await expect(client.exportAccountFile('mtst1account', assertLive)).rejects.toThrow('export-account-file abandoned');
    expect(accountFile.free).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('sends private note', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const mockNote = { id: () => 'note-id', assets: () => [] } as any;
    await client.sendPrivateNote(mockNote, 'recipient-bech32');

    expect(fakeMidenClient.notes.sendPrivateOutput).toHaveBeenCalledWith({
      noteId: 'note-id',
      to: 'recipient-bech32'
    });
  });

  it('executes new transaction and returns TransactionResult', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      TransactionProver: {
        newLocalProver: jest.fn(() => 'local')
      }
    }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.newTransaction('acc-id', new Uint8Array([1, 2]));
    expect(result).toBe(fakeTransactionResult);
    // Staged execute → prove → submit → apply (not the all-in-one
    // `transactions.submit`), so the prove-fallback has a seam to stop at.
    expect(fakeMidenClient.transactions.executeRequest).toHaveBeenCalled();
    expect(fakeMidenClient.transactions.submit).not.toHaveBeenCalled();
  });

  it('waits for transaction commit successfully', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await client.waitForTransactionCommit('tx-123', 5000, 10);
    expect(fakeMidenClient.transactions.waitFor).toHaveBeenCalledWith('tx-123', {
      timeout: 5000,
      interval: 10
    });
  });

  it('throws timeout when transaction does not commit', async () => {
    const fakeMidenClient = buildFakeMidenClient({
      transactions: {
        waitFor: jest.fn(async () => {
          throw new Error('Transaction confirmation timed out after 50ms');
        })
      }
    });

    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await expect(client.waitForTransactionCommit('tx-456', 50, 10)).rejects.toThrow(
      'Transaction confirmation timed out'
    );
  });

  it('sends transaction without recall blocks', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
    }));
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 'Private', Public: 'Public' },
      TransactionProver: {
        newLocalProver: jest.fn(() => 'local')
      },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      getWasmOrThrow: async () => ({
        AccountId: { fromHex: (id: string) => id, fromBech32: (id: string) => id },
        NoteType: { Public: 'public', Private: 'private' }
      })
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.sendTransaction(
      {
        accountId: 'sender',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        noteType: 'public' as any,
        amount: BigInt(100),
        extraInputs: {}
      } as any,
      600
    );

    expect(result).toBe(fakeTransactionResult);
    // The non-offscreen send drives the staged pipeline (executeRequest → prove →
    // submit → apply), not the all-in-one `transactions.send`.
    expect(fakeMidenClient.transactions.executeRequest).toHaveBeenCalled();
    expect(fakeMidenClient.transactions.send).not.toHaveBeenCalled();
    const { buildSendTransactionRequest } = jest.requireMock('./helpers');
    expect(buildSendTransactionRequest.mock.calls[0][6]).toBe(600);
  });

  it('reports executing/proving/submitting stages through the onStage callback', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
    }));
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      TransactionProver: { newLocalProver: jest.fn(() => 'local') },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      getWasmOrThrow: async () => ({
        AccountId: { fromHex: (id: string) => id, fromBech32: (id: string) => id },
        NoteType: { Public: 'public', Private: 'private' }
      })
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const stages: string[] = [];
    await client.sendTransaction(
      {
        accountId: 'sender',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        noteType: 'public' as any,
        amount: BigInt(1),
        extraInputs: {}
      } as any,
      600,
      stage => {
        stages.push(stage);
      }
    );

    expect(stages).toEqual(['executing', 'proving', 'submitting']);
  });

  it('re-runs the staged send pipeline locally when the delegated prover fails', async () => {
    let proveCalls = 0;
    const fakeMidenClient = buildFakeMidenClient({
      transactions: {
        executeRequest: jest.fn(async () => ({
          id: 'tx-id',
          result: fakeTransactionResult,
          prove: jest.fn(async (opts?: any) => {
            proveCalls += 1;
            // Delegated (no prover) attempt fails; the local-prover retry succeeds.
            if (!opts?.prover) throw new Error('remote prover deadline exceeded');
            return { submit: jest.fn(async () => ({ apply: jest.fn(async () => undefined) })) };
          })
        }))
      }
    });

    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
    }));
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      getWasmOrThrow: async () => ({
        AccountId: { fromHex: (id: string) => id, fromBech32: (id: string) => id },
        NoteType: { Public: 'public', Private: 'private' }
      })
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.sendTransaction(
      {
        accountId: 'sender',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        noteType: 'public' as any,
        amount: BigInt(1),
        extraInputs: {},
        delegateTransaction: true
      } as any,
      600
    );

    expect(result).toBe(fakeTransactionResult);
    // The delegated prove threw, so proveWithFallback re-ran the whole staged
    // callback (rebuild → execute → prove → submit → apply) with a local prover —
    // exactly one submit lands, matching the old atomic `.send` re-run semantics.
    expect(fakeMidenClient.transactions.executeRequest).toHaveBeenCalledTimes(2);
    expect(proveCalls).toBe(2);
  });

  // Regression (funds safety): `proveWithFallback`'s callback is not a prove step
  // — for every caller it also submits and applies. Retrying it wholesale after a
  // failure at or AFTER `submit()` re-broadcasts the transfer, and because the
  // send path rebuilds its request each attempt (a fresh random note serial → a
  // different output note the node has no reason to reject as a duplicate) the
  // user is debited twice. It also destroyed the apply-after-submit
  // classification: the retry's error replaced the original, so
  // `isApplyAfterSubmitError` stopped firing and a transfer that IS on chain was
  // marked Failed → the user's Retry then sent a third time.
  const runDelegatedSendFailingAt = async (failAt: 'submit' | 'apply', err: Error) => {
    let submitCalls = 0;
    const fakeMidenClient = buildFakeMidenClient({
      transactions: {
        executeRequest: jest.fn(async () => ({
          id: 'tx-id',
          result: fakeTransactionResult,
          prove: jest.fn(async () => ({
            submit: jest.fn(async () => {
              submitCalls += 1;
              if (failAt === 'submit') throw err;
              return { apply: jest.fn(async () => Promise.reject(err)) };
            })
          }))
        }))
      }
    });
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
    }));
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      getWasmOrThrow: async () => ({
        AccountId: { fromHex: (id: string) => id, fromBech32: (id: string) => id },
        NoteType: { Public: 'public', Private: 'private' }
      })
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
    const rejection = await settleThroughApplyRetry(() =>
      client.sendTransaction(
        {
          accountId: 'sender',
          secondaryAccountId: 'recipient',
          faucetId: 'faucet',
          noteType: 'public' as any,
          amount: BigInt(1),
          extraInputs: {},
          delegateTransaction: true
        } as any,
        600
      )
    );
    return { rejection, fakeMidenClient, submitCalls: () => submitCalls };
  };

  it('does not re-run the send pipeline when the delegated attempt already reached submit - submit rejects (the node may still have accepted it)', async () => {
    const err = new Error('network error while submitting');

    const { rejection, fakeMidenClient, submitCalls } = await runDelegatedSendFailingAt('submit', err);

    // A rejected submit propagates as itself: the node may not have the write.
    expect(rejection).toBe(err);
    expect(fakeMidenClient.transactions.executeRequest).toHaveBeenCalledTimes(1);
    expect(submitCalls()).toBe(1);
  });

  it('does not re-run the send pipeline when the delegated attempt already reached submit - apply rejects after a successful submit (#1233)', async () => {
    // A raw store failure, which is what a staged apply rejects with: only the site's own wrap can
    // say the node already has the write.
    const storeAbort = new Error(
      'IndexedDB transaction aborted while applying the transaction update: QuotaExceededError'
    );

    const { rejection, fakeMidenClient, submitCalls } = await runDelegatedSendFailingAt('apply', storeAbort);
    const { extractSdkErrorCode } = await import('./sdk-error-code');

    expect(extractSdkErrorCode(rejection)).toBe('ApplyTransactionAfterSubmitFailed');
    expect(rejection).toHaveProperty('cause', storeAbort);
    expect(fakeMidenClient.transactions.executeRequest).toHaveBeenCalledTimes(1);
    expect(submitCalls()).toBe(1);
  });

  it('sendTransaction throws a friendly error when _withInnerWebClient is missing', async () => {
    const fakeMidenClient = buildFakeMidenClient({ _withInnerWebClient: undefined });

    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
    }));
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      TransactionProver: { newLocalProver: jest.fn(() => 'local') },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      getWasmOrThrow: async () => ({
        AccountId: { fromHex: (id: string) => id, fromBech32: (id: string) => id },
        NoteType: { Public: 'public', Private: 'private' }
      })
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await expect(
      client.sendTransaction(
        {
          accountId: 'sender',
          secondaryAccountId: 'recipient',
          faucetId: 'faucet',
          noteType: 'public' as any,
          amount: BigInt(1),
          extraInputs: {}
        } as any,
        600
      )
    ).rejects.toThrow(/_withInnerWebClient missing/);
  });

  // A consume the node accepted whose apply then fails must not be re-run: the retry's error would
  // replace the landed one and the row would read Failed. The staged consume reaches that apply
  // itself (#1233), so the SDK's own mempool text arrives wrapped with the landed code.
  it('does not re-run a staged consume whose apply failed after its submit (#1233)', async () => {
    const sdkApplyFailure = new Error(
      "Transaction 0xabc was accepted into the node's mempool at block 42 but the local store update failed."
    );
    const staged = stagedExecuteRequest();
    staged.apply.mockRejectedValue(sdkApplyFailure);
    mockStagedSdk();
    const { MidenClientInterface } = await import('./miden-client-interface');
    const { extractSdkErrorCode } = await import('./sdk-error-code');
    const client = MidenClientInterface.fromClient(
      buildFakeMidenClient({ transactions: { executeRequest: staged.executeRequest } }) as any,
      'testnet'
    );

    const error = await settleThroughApplyRetry(() =>
      client.consumeNoteId(
        {
          accountId: 'acc-id',
          noteId: 'note-1',
          type: 'consume',
          delegateTransaction: true
        } as any,
        600
      )
    );

    expect(extractSdkErrorCode(error)).toBe('ApplyTransactionAfterSubmitFailed');
    expect(error).toHaveProperty('cause', sdkApplyFailure);
    expect(staged.executeRequest).toHaveBeenCalledTimes(1);
  });

  // Swap is staged (#1233), so a delegated prove that fails falls back like the send's. What must
  // never be re-run is a swap whose submit was reached: a retry would draw a fresh serial, mint a
  // SECOND PSWAP note and lock the offered asset twice.
  it('does not re-run a delegated swap whose submit failed', async () => {
    const refused = new Error('node refused the PSWAP');
    const staged = stagedExecuteRequest();
    staged.submit.mockRejectedValueOnce(refused);
    mockStagedSdk();
    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(
      buildFakeMidenClient({
        transactions: { executeRequest: staged.executeRequest },
        // The reference request the vault-key re-emit is measured against.
        __inner: { newPswapCreateTransactionRequest: jest.fn(() => ({ serialize: () => new Uint8Array([3]) })) }
      }) as any,
      'testnet'
    );

    await expect(
      client.swapTransaction(
        {
          accountId: 'acc-id',
          faucetId: 'offered-faucet',
          amount: BigInt(10),
          type: 'swap',
          delegateTransaction: true,
          extraInputs: { requestedFaucetId: 'wanted-faucet', requestedAmount: BigInt(20) }
        } as any,
        600
      )
    ).rejects.toBe(refused);

    expect(staged.executeRequest).toHaveBeenCalledTimes(1);
    expect(staged.prove).toHaveBeenCalledTimes(1);
    expect(staged.submit).toHaveBeenCalledTimes(1);
    const { buildPswapCreateRequest } = jest.requireMock('./helpers');
    expect(buildPswapCreateRequest.mock.calls[0][4]).toBe(600);
  });

  // `newTransaction` (dApp custom transactions + the Agglayer bridged-send) is
  // staged for the same reason the send path is: so a failure at or after submit
  // cannot be retried into a second broadcast of the same request.
  it('does not re-execute newTransaction when the delegated attempt already reached submit', async () => {
    const submitErr = new Error('network error while submitting');
    const executeRequest = jest.fn(async () => ({
      id: 'tx-id',
      result: fakeTransactionResult,
      prove: jest.fn(async () => ({ submit: jest.fn(async () => Promise.reject(submitErr)) }))
    }));
    const fakeMidenClient = buildFakeMidenClient({ transactions: { executeRequest } });

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      TransactionProver: { newLocalProver: jest.fn(() => 'local') },
      TransactionRequest: { deserialize: jest.fn(() => ({})) }
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await expect(client.newTransaction('acc-id', new Uint8Array([1, 2]), true)).rejects.toBe(submitErr);

    expect(executeRequest).toHaveBeenCalledTimes(1);
  });

  it('reports a newTransaction whose apply fails after its submit as submitted, with the store error as its cause (#1233)', async () => {
    const storeAbort = new Error('IndexedDB transaction aborted while applying the transaction update');
    const executeRequest = jest.fn(async () => ({
      id: 'tx-id',
      result: fakeTransactionResult,
      prove: jest.fn(async () => ({
        submit: jest.fn(async () => ({ apply: jest.fn(async () => Promise.reject(storeAbort)) }))
      }))
    }));
    const fakeMidenClient = buildFakeMidenClient({ transactions: { executeRequest } });
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      TransactionProver: { newLocalProver: jest.fn(() => 'local') },
      TransactionRequest: { deserialize: jest.fn(() => ({})) }
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const { extractSdkErrorCode } = await import('./sdk-error-code');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const error = await settleThroughApplyRetry(() => client.newTransaction('acc-id', new Uint8Array([1, 2]), true));

    // A dApp transaction or an Agglayer bridge the node accepted: never re-executed, and reported
    // as landed so the loop catch completes it.
    expect(extractSdkErrorCode(error)).toBe('ApplyTransactionAfterSubmitFailed');
    expect(error).toHaveProperty('cause', storeAbort);
    expect(executeRequest).toHaveBeenCalledTimes(1);
  });

  it('tags a failure raised before markSubmitting, never one at or after it (#1081)', async () => {
    mockStagedSdk();
    const { hasErrorBeforeSubmit } = jest.requireActual('./sdk-error-code');
    const { MidenClientInterface } = await import('./miden-client-interface');
    // A delegated prove that fails, then a local re-prove that fails too: both before the submit.
    const failing = stagedExecuteRequest(() => {
      throw new Error('prover exploded');
    });
    const failingClient = MidenClientInterface.fromClient(
      buildFakeMidenClient({ transactions: { executeRequest: failing.executeRequest } }) as any,
      'net'
    );
    const proveError = await failingClient.newTransaction('acc-id', new Uint8Array([1]), true).catch((e: unknown) => e);
    expect(hasErrorBeforeSubmit(proveError)).toBe(true);
    // A submit the node refuses: at the submit.
    const refused = stagedExecuteRequest();
    refused.submit.mockRejectedValue(new Error('node refused'));
    const refusedClient = MidenClientInterface.fromClient(
      buildFakeMidenClient({ transactions: { executeRequest: refused.executeRequest } }) as any,
      'net'
    );
    const submitError = await refusedClient
      .newTransaction('acc-id', new Uint8Array([1]), true)
      .catch((e: unknown) => e);
    expect(hasErrorBeforeSubmit(submitError)).toBe(false);
  });

  it('tags a recall sync that fails before any request exists (#1081)', async () => {
    mockStagedSdk();
    const { hasErrorBeforeSubmit } = jest.requireActual('./sdk-error-code');
    const { MidenClientInterface } = await import('./miden-client-interface');
    const staged = stagedExecuteRequest();
    const client = MidenClientInterface.fromClient(
      buildFakeMidenClient({
        transactions: { executeRequest: staged.executeRequest },
        sync: jest.fn(async () => {
          throw new Error('sync failed');
        })
      }) as any,
      'net'
    );
    const error = await client
      .sendTransaction(
        {
          accountId: 'acc-id',
          amount: BigInt(1),
          secondaryAccountId: 'recip',
          faucetId: 'faucet',
          noteType: 'public',
          type: 'send',
          extraInputs: { recallBlocks: 10 }
        } as any,
        600
      )
      .catch((e: unknown) => e);
    expect(hasErrorBeforeSubmit(error)).toBe(true);
    expect(staged.executeRequest).not.toHaveBeenCalled();
  });

  it('consumeNoteId returns TransactionResult', async () => {
    const staged = stagedExecuteRequest();
    // `consume` set here because the override replaces the default `transactions` wholesale, and
    // the assertion below needs a mock to read.
    const fakeMidenClient = buildFakeMidenClient({
      transactions: { executeRequest: staged.executeRequest, consume: jest.fn() }
    });
    mockStagedSdk();
    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.consumeNoteId({ accountId: 'acc-id', noteId: 'note-1', type: 'consume' } as any, 600);

    expect(result).toBe(fakeTransactionResult);
    // Staged (#1233): execute, prove, submit and apply, never the SDK's opaque consume.
    expect(staged.executeRequest).toHaveBeenCalledWith('sdk-acc-id', {});
    expect(staged.apply).toHaveBeenCalledTimes(1);
    expect(fakeMidenClient.transactions.consume).not.toHaveBeenCalled();
  });

  it('consumeNoteId: a delegated consume whose remote prover never answers falls back locally (#718)', async () => {
    // A remote prover that goes quiet mid-proof used to park this call forever with the client
    // lock held, and every later claim queued behind it. The delegated prove is bounded and
    // pre-submit, so the fallback re-proves locally on the same notes (#1233 staged the consume).
    jest.useFakeTimers();
    try {
      const staged = stagedExecuteRequest();
      // Delegated attempt: the prove never settles. The local re-prove succeeds.
      staged.prove.mockImplementationOnce(() => new Promise<never>(() => {}));
      const fakeMidenClient = buildFakeMidenClient({ transactions: { executeRequest: staged.executeRequest } });
      mockStagedSdk();
      const { MidenClientInterface, DELEGATED_PROVE_TIMEOUT_MS } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const pending = client.consumeNoteId(
        {
          accountId: 'acc-id',
          noteId: 'note-1',
          type: 'consume',
          delegateTransaction: true
        } as any,
        600
      );

      await jest.advanceTimersByTimeAsync(DELEGATED_PROVE_TIMEOUT_MS);

      expect(await pending).toBe(fakeTransactionResult);
      expect(staged.prove).toHaveBeenCalledTimes(2);
      // First delegated (no explicit prover resolves in this test), then the local prover.
      expect(staged.prove.mock.calls[0]?.[0]?.prover).toBeUndefined();
      expect(staged.prove.mock.calls[1]?.[0]?.prover).toBe('local');
    } finally {
      jest.useRealTimers();
    }
  });

  describe('withDelegatedProveTimeout counts running time only (#473)', () => {
    let doc: HiddenDocument;
    let stopTracking: (() => void) | null = null;

    beforeEach(() => {
      jest.useFakeTimers();
      doc = installHiddenDocument();
    });

    afterEach(() => {
      stopTracking?.();
      stopTracking = null;
      doc.restore();
      jest.useRealTimers();
    });

    // One module registry for both, so the deadline reads the tracker these tests drive.
    async function loadWithTracking() {
      const backgroundTime = await import('lib/mobile/background-time');
      const { withDelegatedProveTimeout } = await import('./miden-client-interface');
      backgroundTime.initBackgroundTimeTracking();
      stopTracking = backgroundTime.__resetBackgroundTimeForTest;
      return withDelegatedProveTimeout;
    }

    function recordOutcome(promise: Promise<unknown>): () => unknown {
      let outcome: unknown;
      promise.then(
        value => {
          outcome = { value };
        },
        (error: unknown) => {
          outcome = { error };
        }
      );
      return () => outcome;
    }

    it('a prove that answers after 150 s, 140 s of them frozen in the background, resolves', async () => {
      const withDelegatedProveTimeout = await loadWithTracking();
      let answer!: (proof: string) => void;
      const outcome = recordOutcome(
        withDelegatedProveTimeout(
          new Promise<string>(resolve => {
            answer = resolve;
          }),
          'Delegated send prove'
        )
      );

      await jest.advanceTimersByTimeAsync(10_000);
      doc.setHidden(true);
      // The deadline's 120 s timer comes due inside the freeze.
      doc.freezeFor(140_000);
      doc.setHidden(false);
      expect(outcome()).toBeUndefined();
      answer('proof');
      // Also drains the zero-delay job a visibilitychange queues from another listener
      // in this import graph, so the only timer that could be left is the deadline.
      await jest.advanceTimersByTimeAsync(0);

      expect(outcome()).toEqual({ value: 'proof' });
      expect(jest.getTimerCount()).toBe(0);
    });

    it('rejects with the same message once 120 s of visible time pass', async () => {
      const withDelegatedProveTimeout = await loadWithTracking();
      const outcome = recordOutcome(withDelegatedProveTimeout(new Promise<never>(() => {}), 'Delegated send prove'));

      await jest.advanceTimersByTimeAsync(119_999);
      expect(outcome()).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      expect(outcome()).toEqual({
        error: new Error('Delegated send prove timed out after 120000ms waiting for the remote prover')
      });
    });

    it('a prove that fails before the deadline cancels it', async () => {
      const withDelegatedProveTimeout = await loadWithTracking();
      const failure = new Error('prover unavailable');

      await expect(withDelegatedProveTimeout(Promise.reject(failure), 'Delegated send prove')).rejects.toBe(failure);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('proveDelegated re-proves remotely once across a freeze (#473)', () => {
    const LABEL = 'Delegated send prove';
    const RETRY_LOG = `[${LABEL}] failed across a frozen stretch; retrying the remote prover once`;
    let doc: HiddenDocument;
    let stopTracking: (() => void) | null = null;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers();
      doc = installHiddenDocument();
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      stopTracking?.();
      stopTracking = null;
      doc.restore();
      warnSpy.mockRestore();
      jest.useRealTimers();
    });

    // Each `newRemoteProver` call returns a distinct handle, so a retry's fresh prover is visible.
    async function loadProveDelegated() {
      let made = 0;
      const newRemoteProver = jest.fn(() => ({ remote: ++made }));
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        TransactionProver: { newRemoteProver, newLocalProver: jest.fn(() => 'local') }
      }));
      jest.doMock('lib/miden-chain/effective-endpoints', () => ({
        getEffectiveNetworkName: () => 'localnet',
        getEffectiveRpcUrl: () => 'rpc-local',
        getEffectiveProverUrl: () => 'https://prover.example',
        getEffectiveNoteTransportUrl: () => undefined
      }));
      const backgroundTime = await import('lib/mobile/background-time');
      const { proveDelegated } = await import('./miden-client-interface');
      backgroundTime.initBackgroundTimeTracking();
      stopTracking = backgroundTime.__resetBackgroundTimeForTest;
      return { proveDelegated, newRemoteProver };
    }

    /** A prove that stays in flight until the test fails it. */
    function pendingProve() {
      let fail!: (error: unknown) => void;
      const promise = new Promise<never>((_, reject) => {
        fail = reject;
      });
      return { promise, fail };
    }

    function freezeFor(ms: number) {
      doc.setHidden(true);
      doc.freezeFor(ms);
      doc.setHidden(false);
    }

    it('a prove that fails across a freeze is re-proved once with a fresh remote prover', async () => {
      const { proveDelegated, newRemoteProver } = await loadProveDelegated();
      const first = pendingProve();
      const prove = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('proof');
      const beforeRetry = jest.fn();
      const proving = proveDelegated(prove, LABEL, beforeRetry);

      freezeFor(140_000);
      const failure = new Error('DeadlineExceeded: Request timed out');
      first.fail(failure);

      await expect(proving).resolves.toBe('proof');
      expect(prove).toHaveBeenCalledTimes(2);
      expect(prove.mock.calls[0]?.[0]).toEqual({ remote: 1 });
      expect(prove.mock.calls[1]?.[0]).toEqual({ remote: 2 });
      expect(newRemoteProver).toHaveBeenCalledTimes(2);
      expect(beforeRetry).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(RETRY_LOG, failure);
      // Drains the zero-delay job a visibilitychange queues from another listener in this import
      // graph, so a timer left now is a deadline that was not cancelled.
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('a prove that fails across a 40 s freeze is re-proved once remotely', async () => {
      const { proveDelegated, newRemoteProver } = await loadProveDelegated();
      const first = pendingProve();
      const prove = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('proof');
      const settled = proveDelegated(prove, LABEL, jest.fn()).then(
        value => ({ value }),
        (error: unknown) => ({ error })
      );

      freezeFor(40_000);
      first.fail(new Error('DeadlineExceeded: Request timed out'));
      const outcome = await settled;

      expect(newRemoteProver).toHaveBeenCalledTimes(2);
      expect(outcome).toEqual({ value: 'proof' });
      expect(prove).toHaveBeenCalledTimes(2);
    });

    it('a failure with no frozen time does not retry', async () => {
      const { proveDelegated } = await loadProveDelegated();
      const failure = new Error('prover unavailable');
      const prove = jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce('proof');
      const beforeRetry = jest.fn();

      await expect(proveDelegated(prove, LABEL, beforeRetry)).rejects.toBe(failure);
      expect(prove).toHaveBeenCalledTimes(1);
      expect(beforeRetry).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('a second failure propagates, the retry having run under a fresh 120 s deadline', async () => {
      const { proveDelegated } = await loadProveDelegated();
      const first = pendingProve();
      const prove = jest
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(new Promise<never>(() => {}));
      let outcome: unknown = 'pending';
      proveDelegated(prove, LABEL, jest.fn()).then(
        () => {
          outcome = 'resolved';
        },
        (error: unknown) => {
          outcome = error;
        }
      );

      freezeFor(140_000);
      first.fail(new Error('DeadlineExceeded: Request timed out'));
      // The first attempt's deadline had 115 s left; the retry gets a whole one.
      await jest.advanceTimersByTimeAsync(119_999);
      expect(prove).toHaveBeenCalledTimes(2);
      expect(outcome).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);

      expect(outcome).toEqual(new Error(`${LABEL} timed out after 120000ms waiting for the remote prover`));
      expect(prove).toHaveBeenCalledTimes(2);
    });

    it('a trap across a freeze is never retried', async () => {
      const { proveDelegated } = await loadProveDelegated();
      const first = pendingProve();
      const prove = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('proof');
      const beforeRetry = jest.fn();
      const proving = proveDelegated(prove, LABEL, beforeRetry);

      freezeFor(140_000);
      const trap = new WebAssembly.RuntimeError('unreachable');
      first.fail(trap);

      await expect(proving).rejects.toBe(trap);
      expect(prove).toHaveBeenCalledTimes(1);
      expect(beforeRetry).not.toHaveBeenCalled();
    });

    it('a throwing beforeRetry propagates and no second prove starts', async () => {
      const { proveDelegated } = await loadProveDelegated();
      const first = pendingProve();
      const prove = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('proof');
      const holdGone = new Error('hold lost');
      const proving = proveDelegated(prove, LABEL, () => {
        throw holdGone;
      });

      freezeFor(140_000);
      first.fail(new Error('DeadlineExceeded: Request timed out'));

      await expect(proving).rejects.toBe(holdGone);
      expect(prove).toHaveBeenCalledTimes(1);
    });

    it('a consume whose client was retired during the freeze starts no remote re-prove', async () => {
      const first = pendingProve();
      const staged = stagedExecuteRequest();
      staged.prove.mockReturnValueOnce(first.promise);
      const fakeMidenClient = buildFakeMidenClient({ transactions: { executeRequest: staged.executeRequest } });
      mockStagedSdk();
      const backgroundTime = await import('lib/mobile/background-time');
      const { MidenClientInterface } = await import('./miden-client-interface');
      backgroundTime.initBackgroundTimeTracking();
      stopTracking = backgroundTime.__resetBackgroundTimeForTest;
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      let outcome: unknown = 'pending';
      client
        .consumeNoteId(
          { accountId: 'acc-id', noteId: 'note-1', type: 'consume', delegateTransaction: true } as any,
          600
        )
        .then(
          () => {
            outcome = 'resolved';
          },
          (error: unknown) => {
            outcome = error;
          }
        );
      await jest.advanceTimersByTimeAsync(0);
      expect(staged.prove).toHaveBeenCalledTimes(1);

      freezeFor(140_000);
      client.markPoisoned();
      first.fail(new Error('DeadlineExceeded: Request timed out'));
      await jest.advanceTimersByTimeAsync(0);

      expect(staged.prove).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ name: 'WasmClientPoisonedError' });
    });
  });

  it('consumeNoteId consumes every noteId in one transaction when a batch is given', async () => {
    const staged = stagedExecuteRequest();
    const inner = {
      getInputNote: jest.fn(async (id: string) => ({ toNote: () => ({ note: id }) })),
      newConsumeTransactionRequest: jest.fn(async (_notes: unknown[], _account: unknown) => ({
        serialize: () => new Uint8Array([8])
      }))
    };
    const fakeMidenClient = buildFakeMidenClient({
      transactions: { executeRequest: staged.executeRequest },
      __inner: inner
    });
    mockStagedSdk();
    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await client.consumeNoteId(
      {
        accountId: 'acc-id',
        noteId: 'note-1',
        noteIds: ['note-1', 'note-2', 'note-3'],
        type: 'consume'
      } as any,
      600
    );

    const { buildConsumeTransactionRequest } = jest.requireMock('./helpers');
    expect(buildConsumeTransactionRequest).toHaveBeenCalledWith(expect.any(Array), 600);
    // The SDK's finished request has no expiration setter, so it is no longer built.
    expect(inner.newConsumeTransactionRequest).not.toHaveBeenCalled();
    // Claim All batches into a single consume (one proof, one submit) rather
    // than falling back to the singular `noteId`.
    expect(buildConsumeTransactionRequest).toHaveBeenCalledTimes(1);
    expect(buildConsumeTransactionRequest.mock.calls[0]?.[0]).toEqual([
      { note: 'note-1' },
      { note: 'note-2' },
      { note: 'note-3' }
    ]);
    expect(staged.submit).toHaveBeenCalledTimes(1);
  });

  describe('miscellaneous branches', () => {
    it('create() returns a mock-network client when MIDEN_USE_MOCK_CLIENT=true', async () => {
      const fakeMockClient = buildFakeMidenClient();
      const createMock = jest.fn(async () => fakeMockClient);

      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        NoteType: { Private: 0, Public: 1 },
        MidenClient: { create: jest.fn(), createMock },
        NoteFile: { deserialize: jest.fn(() => ({})) },
        AccountFile: { deserialize: jest.fn(() => ({})) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        TransactionProver: {
          newRemoteProver: jest.fn(() => 'remote'),
          newLocalProver: jest.fn(() => 'local')
        },
        NoteExportFormat: { Id: 'Id', Full: 'Full', Details: 'Details' },
        exportStore: jest.fn(async () => '{}'),
        importStore: jest.fn()
      }));
      jest.doMock('lib/miden-chain/effective-endpoints', () => ({
        getEffectiveNetworkName: () => 'localnet',
        getEffectiveRpcUrl: () => 'rpc',
        getEffectiveProverUrl: () => undefined,
        getEffectiveNoteTransportUrl: () => undefined
      }));
      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
        buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({ addConnectivityIssue: jest.fn() }));

      const prev = process.env.MIDEN_USE_MOCK_CLIENT;
      process.env.MIDEN_USE_MOCK_CLIENT = 'true';
      try {
        const { MidenClientInterface } = await import('./miden-client-interface');
        const client = await MidenClientInterface.create({ seed: new Uint8Array([1, 2, 3]) });
        expect(client.network).toBe('mock');
        expect(createMock).toHaveBeenCalledWith({ seed: expect.any(Uint8Array) });
      } finally {
        process.env.MIDEN_USE_MOCK_CLIENT = prev;
      }
    });

    it('create() omits keystore when no keystore callbacks are provided', async () => {
      const fakeMidenClient = buildFakeMidenClient();
      const createReal = jest.fn(async () => fakeMidenClient);

      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        NoteType: { Private: 0, Public: 1 },
        MidenClient: { create: createReal, createMock: jest.fn() },
        NoteFile: { deserialize: jest.fn(() => ({})) },
        AccountFile: { deserialize: jest.fn(() => ({})) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        TransactionProver: {
          newRemoteProver: jest.fn(() => 'remote'),
          newLocalProver: jest.fn(() => 'local')
        },
        NoteExportFormat: { Id: 'Id', Full: 'Full', Details: 'Details' },
        exportStore: jest.fn(async () => '{}'),
        importStore: jest.fn()
      }));
      jest.doMock('lib/miden-chain/effective-endpoints', () => ({
        getEffectiveNetworkName: () => 'localnet',
        getEffectiveRpcUrl: () => 'rpc',
        getEffectiveProverUrl: () => undefined,
        getEffectiveNoteTransportUrl: () => undefined
      }));
      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
        buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({ addConnectivityIssue: jest.fn() }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      await MidenClientInterface.create({}); // no callbacks → hasKeystore=false → keystore: undefined

      expect(createReal).toHaveBeenCalledWith(
        expect.objectContaining({
          keystore: undefined
        })
      );
    });

    it('create() refuses by name the keystore members the creator left out (#878)', async () => {
      const fakeMidenClient = buildFakeMidenClient();
      const createReal = jest.fn(async (_options: any) => fakeMidenClient);

      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        NoteType: { Private: 0, Public: 1 },
        MidenClient: { create: createReal, createMock: jest.fn() },
        NoteFile: { deserialize: jest.fn(() => ({})) },
        AccountFile: { deserialize: jest.fn(() => ({})) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        TransactionProver: {
          newRemoteProver: jest.fn(() => 'remote'),
          newLocalProver: jest.fn(() => 'local')
        },
        NoteExportFormat: { Id: 'Id', Full: 'Full', Details: 'Details' },
        exportStore: jest.fn(async () => '{}'),
        importStore: jest.fn()
      }));
      jest.doMock('lib/miden-chain/effective-endpoints', () => ({
        getEffectiveNetworkName: () => 'localnet',
        getEffectiveRpcUrl: () => 'rpc',
        getEffectiveProverUrl: () => undefined,
        getEffectiveNoteTransportUrl: () => undefined
      }));
      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
        buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({ addConnectivityIssue: jest.fn() }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const signCallback = jest.fn(async () => new Uint8Array([1]));
      // The offscreen document's shape: a signer and nothing else.
      await MidenClientInterface.create({ signCallback });

      const { keystore } = createReal.mock.calls[0]![0];
      // Functions that refuse by name, not undefined slots: a TypeError on an undefined
      // member would also name it, so the pin is the refusal phrase and the type.
      expect(typeof keystore.getKey).toBe('function');
      expect(typeof keystore.insertKey).toBe('function');
      await expect(keystore.getKey('pk')).rejects.toThrow(
        'getKey requested on a client created with no getKey callback'
      );
      await expect(keystore.insertKey('pk', 'sk')).rejects.toThrow(
        'insertKey requested on a client created with no insertKey callback'
      );
      expect(typeof keystore.sign).toBe('function');
      expect(keystore.sign).not.toBe(signCallback);
    });

    it('createGuardianMidenWallet returns accountId + hot/cold key material', async () => {
      const fakeMidenClient = buildFakeMidenClient();
      const keys = {
        hotPublicKey: 'hot-pub',
        coldPublicKey: 'cold-pub',
        hotCiphertext: 'hot-ct',
        coldSecretKeyHex: 'cold-sk'
      };
      const createGuardianAccount = jest.fn(async () => ({
        account: { id: () => ({ toString: () => 'guardian-id' }) },
        keys,
        guardianEndpoint: 'https://picked-guardian.example',
        registration: { stateBase64: 'state' }
      }));

      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => (typeof id === 'function' ? id().toString() : String(id)),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
        buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
      }));
      jest.doMock('screens/onboarding/types', () => ({
        WalletType: { OnChain: 'on-chain', OffChain: 'off-chain', Guardian: 'guardian' }
      }));
      jest.doMock('../guardian/account', () => ({
        createGuardianAccount,
        getSignerDetailsFromAccount: jest.fn()
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({
        addConnectivityIssue: jest.fn()
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const createKey = {
        guardianEndpoint: 'https://picked-guardian.example',
        guardianCommitment: 'c',
        guardianPubkey: 'p',
        rateLimitBudgetLeftMs: 90_000
      };
      const assertLive = jest.fn();
      const result = await client.createGuardianMidenWallet(new Uint8Array([9]), createKey, assertLive);

      // The caller fetched createKey before this hold (#1207) and forwards it
      // straight through; the caller's hold re-check goes through as itself:
      // any other function drops every re-check the vault's hold relies on.
      expect(createGuardianAccount).toHaveBeenCalledWith(
        fakeMidenClient,
        createKey,
        expect.any(Uint8Array),
        assertLive
      );
      expect(result).toEqual({
        accountId: 'guardian-id',
        keys,
        guardianEndpoint: 'https://picked-guardian.example',
        registration: { stateBase64: 'state' }
      });
    });

    // A Guardian account is created only through createGuardianMidenWallet, whose caller fetches
    // the key before its hold and registers after it (#1207); createMidenWallet runs inside a hold.
    it('createMidenWallet refuses a Guardian wallet type, fetching no guardian key and building no account', async () => {
      const fakeMidenClient = buildFakeMidenClient();
      const fetchGuardianCreateKey = jest.fn(async () => ({
        guardianEndpoint: 'https://default-guardian.example',
        guardianCommitment: 'c',
        rateLimitBudgetLeftMs: 90_000
      }));
      const createGuardianAccount = jest.fn(async () => ({
        account: { id: () => ({ toString: () => 'guardian-id' }) },
        registration: { stateBase64: 'state' }
      }));

      jest.doMock('./helpers', () => ({ getBech32AddressFromAccountId: (id: unknown) => String(id) }));
      jest.doMock('screens/onboarding/types', () => ({
        WalletType: { OnChain: 'on-chain', OffChain: 'off-chain', Guardian: 'guardian' }
      }));
      jest.doMock('../guardian/account', () => ({
        fetchGuardianCreateKey,
        createGuardianAccount,
        registerGuardianAccount: jest.fn(async () => {}),
        getSignerDetailsFromAccount: jest.fn()
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({
        addConnectivityIssue: jest.fn()
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const { WalletType } = await import('screens/onboarding/types');
      const client = MidenClientInterface.fromClient(fakeMidenClient as never, 'testnet');

      await expect(client.createMidenWallet(WalletType.Guardian, new Uint8Array([9]))).rejects.toThrow(
        'createGuardianMidenWallet'
      );
      expect(fetchGuardianCreateKey).not.toHaveBeenCalled();
      expect(createGuardianAccount).not.toHaveBeenCalled();
      expect(fakeMidenClient.accounts.create).not.toHaveBeenCalled();
    });

    // Shared by the two recovery cases below: two matches at HD index 0, then misses until the gap
    // limit ends the scan (a hold per match is two holds; one hoisted around the index's matches
    // would be one). The lock mock counts holds and records labels; the adoption and the key insert
    // refuse a call made outside a hold; the hold check throws the poison error once revoked.
    const setupRecovery = async (onLookup?: (client: MidenClientInterfaceType) => void, { finds = true } = {}) => {
      const held = { count: 0, labels: [] as string[], revoked: false };
      let iface: MidenClientInterfaceType | undefined;
      const requireHeld = (what: string) => {
        if (held.count === 0) throw new Error(`${what} called with no WASM lock hold`);
      };
      const insert = jest.fn(async () => requireHeld('keystore.insert'));
      const adopt = jest.fn(async (_client: unknown, _account: unknown) =>
        requireHeld('insertGuardianAccountMonotonically')
      );
      const fakeMidenClient = { ...buildFakeMidenClient(), keystore: { insert } };
      let lookups = 0;
      const matchAt = (n: number) => ({ state: { stateJson: { data: Buffer.from([n]).toString('base64') } } });
      const accounts = [
        { id: () => ({ toString: () => 'recovered-a' }) },
        { id: () => ({ toString: () => 'recovered-b' }) }
      ];

      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
        AuthSecretKey: {
          ecdsaWithRNG: jest.fn(() => ({
            publicKey: () => ({ serialize: () => new Uint8Array([0, 0xaa, 0xbb]) }),
            serialize: () => new Uint8Array([0xcc])
          }))
        },
        Account: { deserialize: jest.fn(() => accounts.shift()) }
      }));
      jest.doMock('./miden-client', () => {
        const { WasmClientPoisonedError } = jest.requireActual('./wasm-client-poison');
        return {
          withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>, options?: { label?: string }) => {
            held.count++;
            held.labels.push(options?.label ?? '');
            try {
              return await fn({});
            } finally {
              held.count--;
            }
          },
          assertWasmHoldCurrent: (_hold: object, where: string) => {
            if (held.revoked) throw new WasmClientPoisonedError('watchdog', new Error(`operation abandoned ${where}`));
          },
          yieldWasmClientLock: async <T>(op: () => Promise<T>) => op(),
          withWasmLockWatchdogPaused: async <T>(op: () => Promise<T>) => op(),
          getCurrentWasmLockHold: () => null
        };
      });
      jest.doMock('@openzeppelin/miden-multisig-client', () => ({
        MultisigClient: class {
          recoverByKey = jest.fn(async () => {
            if (iface) onLookup?.(iface);
            return finds && lookups++ === 0 ? [matchAt(1), matchAt(2)] : [];
          });
        },
        EcdsaSigner: class {}
      }));
      jest.doMock('../guardian/account', () => ({
        createGuardianAccount: jest.fn(),
        getSignerDetailsFromAccount: jest.fn(),
        insertGuardianAccountMonotonically: adopt
      }));
      jest.doMock('../guardian/native-http');
      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => (typeof id === 'function' ? id().toString() : String(id))
      }));
      jest.doMock('lib/miden-chain/effective-endpoints', () => ({
        getEffectiveNetworkName: () => 'testnet',
        getEffectiveRpcUrl: () => 'https://rpc.example',
        getEffectiveProverUrl: () => undefined,
        getEffectiveNoteTransportUrl: () => undefined
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({ addConnectivityIssue: jest.fn() }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
      iface = client;
      const recover = () => client.recoverGuardianAccountsBySeed(() => new Uint8Array(32), 'https://guardian.example');
      return { held, insert, adopt, fakeMidenClient, recover, probes: requireProbes() };
    };

    it('recoverGuardianAccountsBySeed adopts each match under the WASM lock and inserts its cold key', async () => {
      const { held, insert, adopt, fakeMidenClient, recover, probes } = await setupRecovery();

      const recovered = await recover();

      expect(recovered).toEqual([
        { accountId: 'recovered-a', hdIndex: 0, coldPublicKey: 'aabb', coldSecretKeyHex: 'cc' },
        { accountId: 'recovered-b', hdIndex: 0, coldPublicKey: 'aabb', coldSecretKeyHex: 'cc' }
      ]);
      // One labelled hold per match; the adoption and the insert ran inside it, on this client, with that match.
      expect(held.labels).toEqual(['recover-guardian-adopt', 'recover-guardian-adopt']);
      expect(adopt.mock.calls.map(([c, a]) => [c, (a as any).id().toString()])).toEqual([
        [fakeMidenClient, 'recovered-a'],
        [fakeMidenClient, 'recovered-b']
      ]);
      expect(insert).toHaveBeenCalledTimes(2);
      expect(held.count).toBe(0);
      // Not yet bound, so the endpoint stays routed only once an account is adopted from it.
      expect(probes.mockProbeVerdicts).toEqual([['https://guardian.example', true]]);
      expect(probes.registerGuardianOrigin).not.toHaveBeenCalled();
    });

    it('recoverGuardianAccountsBySeed releases an endpoint with no account for the seed, never registering it', async () => {
      const { recover, probes } = await setupRecovery(undefined, { finds: false });
      const { NoGuardianAccountsFoundError } = await import('./guardian-recovery-errors');

      await expect(recover()).rejects.toBeInstanceOf(NoGuardianAccountsFoundError);
      expect(probes.mockProbeVerdicts).toEqual([['https://guardian.example', false]]);
      expect(probes.registerGuardianOrigin).not.toHaveBeenCalled();
    });

    it('recoverGuardianAccountsBySeed: a client replaced during the lookup adopts nothing (#775)', async () => {
      // The lookup parks outside the lock; the singleton is replaced under it.
      const { insert, adopt, recover } = await setupRecovery(client => client.markPoisoned());

      await expect(recover()).rejects.toThrow('The Miden client was replaced while scanning for Guardian accounts');
      expect(adopt).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    });

    it('recoverGuardianAccountsBySeed: an eviction during the adoption stops the cold-key insert (#775)', async () => {
      const { held, insert, adopt, recover } = await setupRecovery();
      adopt.mockImplementationOnce(async () => {
        held.revoked = true;
      });

      await expect(recover()).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      expect(insert).not.toHaveBeenCalled();
      expect(held.count).toBe(0);
    });

    it('a guardian lookup that never answers makes the recovery reject after one attempt instead of parking the accounts queue (#878)', async () => {
      const fakeMidenClient = { ...buildFakeMidenClient(), keystore: { insert: jest.fn(async () => undefined) } };
      const recoverByKey = jest.fn(() => new Promise<never>(() => {}));
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
        AuthSecretKey: {
          ecdsaWithRNG: jest.fn(() => ({
            publicKey: () => ({ serialize: () => new Uint8Array([0, 0xaa, 0xbb]) }),
            serialize: () => new Uint8Array([0xcc])
          }))
        }
      }));
      jest.doMock('./miden-client', () => ({
        withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => fn({}),
        yieldWasmClientLock: async <T>(op: () => Promise<T>) => op(),
        withWasmLockWatchdogPaused: async <T>(op: () => Promise<T>) => op(),
        getCurrentWasmLockHold: () => null
      }));
      jest.doMock('@openzeppelin/miden-multisig-client', () => ({
        MultisigClient: class {
          recoverByKey = recoverByKey;
        },
        EcdsaSigner: class {}
      }));
      jest.doMock('../guardian/native-http');
      jest.doMock('lib/miden-chain/effective-endpoints', () => ({
        getEffectiveNetworkName: () => 'testnet',
        getEffectiveRpcUrl: () => 'https://rpc.example',
        getEffectiveProverUrl: () => undefined,
        getEffectiveNoteTransportUrl: () => undefined
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({ addConnectivityIssue: jest.fn() }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      jest.useFakeTimers();
      try {
        const pending = client.recoverGuardianAccountsBySeed(() => new Uint8Array(32), 'https://guardian.example');
        pending.catch(() => {});
        // Past the bound: one attempt, no retry (an abandoned attempt is never aborted).
        await jest.advanceTimersByTimeAsync(30_000 + 1_000);
        await expect(pending).rejects.toThrow();
        expect(recoverByKey).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('getInputNote delegates to client.notes.get and returns its result', async () => {
      const fakeMidenClient = buildFakeMidenClient({
        notes: { get: jest.fn(async () => 'fetched-note') }
      });

      jest.doMock('lib/miden/activity/connectivity-issues', () => ({ addConnectivityIssue: jest.fn() }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await expect(client.getInputNote('note-xyz')).resolves.toBe('fetched-note' as never);
      expect(fakeMidenClient.notes.get).toHaveBeenCalledWith('note-xyz');
    });
  });

  describe('recoverGuardianAccountByHotKey', () => {
    // The pasted key's commitment as its toHex() returns it (0x-prefixed); the method
    // normalizes it and each on-chain signer commitment before comparing.
    const PASTED_COMMITMENT = '0xaabb';

    // The lookup itself (recoverAndAdoptByKey) is spied on the instance rather than
    // driven end to end (that path is already covered by the recoverGuardianAccountsBySeed
    // tests above); what's under test here is this method's own not-found throw and its
    // adopt callback's two refusals, so only the key handling around them runs for real.
    const setup = (getSignerDetailsFromAccount: jest.Mock = jest.fn()) => {
      const publicKey = {
        serialize: () => new Uint8Array([0, 0x11, 0x22]),
        toCommitment: () => ({ toHex: () => PASTED_COMMITMENT, free: jest.fn() }),
        free: jest.fn()
      };
      jest.doMock('../guardian/hot-key-import', () => ({
        deserializeHotSecretKey: jest.fn(() => ({ publicKey: () => publicKey }))
      }));
      jest.doMock('lib/i18n', () => ({ getMessage: jest.fn((key: string) => key) }));
      jest.doMock('../guardian/native-http');
      jest.doMock('../guardian/account', () => ({
        getSignerDetailsFromAccount,
        insertGuardianAccountMonotonically: jest.fn(),
        createGuardianAccount: jest.fn()
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({ addConnectivityIssue: jest.fn() }));
    };

    // recoverAndAdoptByKey's 3rd argument is the adopt callback under test; invoking it
    // with a stub account exercises its accept path and two refusals without a real lookup.
    const spyRecoverAndAdoptByKeyInvokingVerify = (client: unknown, stubAccount: unknown) =>
      jest.spyOn(client as any, 'recoverAndAdoptByKey').mockImplementation(async (...args: unknown[]) => {
        const verify = args[2] as ((acc: unknown) => Promise<void>) | undefined;
        await verify?.(stubAccount);
        return ['unreachable'];
      });

    it('rejects with GUARDIAN_ACCOUNT_NOT_FOUND and the localized no-account message when nothing was adopted', async () => {
      setup();
      const { MidenClientInterface } = await import('./miden-client-interface');
      const { GUARDIAN_ACCOUNT_NOT_FOUND, NoGuardianAccountsFoundError } = await import('./guardian-recovery-errors');
      const client = MidenClientInterface.fromClient(buildFakeMidenClient() as any, 'testnet');
      jest.spyOn(client as any, 'recoverAndAdoptByKey').mockResolvedValue([]);

      const rejection = client.recoverGuardianAccountByHotKey('deadbeef', 'https://guardian.example');

      await expect(rejection).rejects.toBeInstanceOf(NoGuardianAccountsFoundError);
      await expect(rejection).rejects.toMatchObject({
        code: GUARDIAN_ACCOUNT_NOT_FOUND,
        message: 'importHotKeyNoAccount'
      });
      expect(requireProbes().mockProbeVerdicts).toEqual([['https://guardian.example', false]]);
    });

    it('releases the endpoint when the lookup fails, never registering it', async () => {
      setup();
      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(buildFakeMidenClient() as any, 'testnet');
      jest.spyOn(client as any, 'recoverAndAdoptByKey').mockRejectedValue(new Error('HTTP 404'));

      await expect(client.recoverGuardianAccountByHotKey('deadbeef', 'https://guardian.example')).rejects.toThrow(
        'HTTP 404'
      );
      expect(requireProbes().mockProbeVerdicts).toEqual([['https://guardian.example', false]]);
      expect(requireProbes().registerGuardianOrigin).not.toHaveBeenCalled();
    });

    it('resolves with the adopted account when the pasted key is the current hot key, in any case or prefix', async () => {
      const stubAccount = {};
      const getSignerDetailsFromAccount = jest.fn().mockResolvedValueOnce({ commitment: 'AABB' });
      setup(getSignerDetailsFromAccount);
      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(buildFakeMidenClient() as any, 'testnet');
      spyRecoverAndAdoptByKeyInvokingVerify(client, stubAccount);

      await expect(client.recoverGuardianAccountByHotKey('deadbeef', 'https://guardian.example')).resolves.toEqual([
        { accountId: 'unreachable', hotPublicKey: '1122' }
      ]);
      expect(getSignerDetailsFromAccount).toHaveBeenCalledTimes(1);
      expect(requireProbes().mockProbeVerdicts).toEqual([['https://guardian.example', true]]);
    });

    it('rejects with no code when the pasted key matches only the recovery (cold) key', async () => {
      const stubAccount = {};
      const getSignerDetailsFromAccount = jest
        .fn()
        .mockResolvedValueOnce({ commitment: 'ffff' })
        .mockResolvedValueOnce({ commitment: 'AABB' });
      setup(getSignerDetailsFromAccount);
      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(buildFakeMidenClient() as any, 'testnet');
      spyRecoverAndAdoptByKeyInvokingVerify(client, stubAccount);

      const rejection = client.recoverGuardianAccountByHotKey('deadbeef', 'https://guardian.example');

      await expect(rejection).rejects.toMatchObject({ message: 'importHotKeyIsRecoveryKey' });
      await expect(rejection).rejects.not.toHaveProperty('code');
      expect(getSignerDetailsFromAccount).toHaveBeenNthCalledWith(1, stubAccount, false);
      expect(getSignerDetailsFromAccount).toHaveBeenNthCalledWith(2, stubAccount, true);
    });

    it('rejects with no code when the pasted key matches neither the hot nor the recovery key', async () => {
      const stubAccount = {};
      const getSignerDetailsFromAccount = jest
        .fn()
        .mockResolvedValueOnce({ commitment: 'ffff' })
        .mockResolvedValueOnce({ commitment: 'eeee' });
      setup(getSignerDetailsFromAccount);
      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(buildFakeMidenClient() as any, 'testnet');
      spyRecoverAndAdoptByKeyInvokingVerify(client, stubAccount);

      const rejection = client.recoverGuardianAccountByHotKey('deadbeef', 'https://guardian.example');

      await expect(rejection).rejects.toMatchObject({ message: 'importHotKeyNotActive' });
      await expect(rejection).rejects.not.toHaveProperty('code');
    });
  });

  describe('importAccountBySeed', () => {
    it('delegates to importPublicMidenWalletFromSeed', async () => {
      const fakeMidenClient = buildFakeMidenClient({
        accounts: {
          import: jest.fn(async () => ({ id: () => 'public-acc-id' }))
        }
      });

      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
        buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
      }));
      jest.doMock('screens/onboarding/types', () => ({
        WalletType: { OnChain: 'on-chain', OffChain: 'off-chain', Guardian: 'guardian' }
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({
        addConnectivityIssue: jest.fn()
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const result = await client.importAccountBySeed(new Uint8Array([1, 2, 3]));

      expect(result).toBe('public-acc-id');
      expect(fakeMidenClient.accounts.import).toHaveBeenCalledWith({ seed: expect.any(Uint8Array) });
    });

    // importGuardianAccountBySeed was removed in Phase 8 — replaced by the
    // atomic recoverGuardianAccountsBySeed orchestrator that does lookup +
    // adopt + cold-signed `replace_signer` rotation in one step. The
    // orchestrator's end-to-end behavior depends on the guardian SDK,
    // secureHotKey facade, and on-chain proving — covered by the manual
    // devnet smoke in the Phase 8 plan rather than a fully-mocked unit
    // test. Phase 9 will add comprehensive coverage with a faked
    // MultisigClient.
  });

  it('recordProveTiming swallows globalThis.__PROVE_TIMINGS__ push errors silently', async () => {
    // Cover the catch branch in recordProveTiming — verifies the helper
    // doesn't throw when __PROVE_TIMINGS__ is frozen / non-writable.
    const prevFlag = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    Object.defineProperty(globalThis, '__PROVE_TIMINGS__', {
      value: Object.freeze([]),
      writable: false,
      configurable: true
    });

    try {
      mockStagedSdk();

      const fakeMidenClient = buildFakeMidenClient();
      await jest.isolateModulesAsync(async () => {
        const { MidenClientInterface } = await import('./miden-client-interface');
        const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
        // Should not throw despite the frozen array — the catch swallows it.
        const result = await client.consumeNoteId(
          {
            accountId: 'acc-id',
            noteId: 'note-1',
            type: 'consume'
          } as any,
          600
        );
        expect(result).toBe(fakeTransactionResult);
      });
    } finally {
      if (prevFlag === undefined) {
        delete process.env.MIDEN_E2E_TEST;
      } else {
        process.env.MIDEN_E2E_TEST = prevFlag;
      }
      Object.defineProperty(globalThis, '__PROVE_TIMINGS__', {
        value: undefined,
        writable: true,
        configurable: true
      });
      delete (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__;
    }
  });

  it('consumeNoteId records prove-timing markers under MIDEN_E2E_TEST=true', async () => {
    // The PROVE_TIMING_ENABLED constant is captured at module-load time,
    // so isolateModules + a fresh require is needed to flip the gate on.
    const prevFlag = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    delete (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__;

    try {
      mockStagedSdk();

      const fakeMidenClient = buildFakeMidenClient();
      let consumeResult!: unknown;
      await jest.isolateModulesAsync(async () => {
        const { MidenClientInterface } = await import('./miden-client-interface');
        const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
        consumeResult = await client.consumeNoteId(
          {
            accountId: 'acc-id',
            noteId: 'note-1',
            type: 'consume'
          } as any,
          600
        );
      });

      expect(consumeResult).toBe(fakeTransactionResult);
      const markers = (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__ ?? [];
      expect(markers.length).toBeGreaterThan(0);
      expect(markers.some(l => /consumeNoteId entered/.test(l))).toBe(true);
      expect(markers.some(l => /consumeNoteId staged consume returned/.test(l))).toBe(true);
    } finally {
      if (prevFlag === undefined) {
        delete process.env.MIDEN_E2E_TEST;
      } else {
        process.env.MIDEN_E2E_TEST = prevFlag;
      }
      delete (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__;
    }
  });

  it('localProverFactory uses newCallbackProver(buildNativeProverCallback()) when isMobile()', async () => {
    // Mobile path branch — withProverFallback should construct a
    // CallbackProver routed through the native-prover plugin, not a
    // LocalProver. Mocks isMobile + native-prover plugin + TransactionProver
    // so the branch is reachable from jsdom without a real Capacitor host.
    const newCallbackProver = jest.fn(
      (_callback: (input: Uint8Array) => Promise<Uint8Array>) => 'callback-prover-instance'
    );
    const newLocalProver = jest.fn(() => 'should-not-be-called');
    const nativeProverPlugin = { prove: jest.fn() };

    const staged = stagedExecuteRequest();
    const fakeMidenClient = buildFakeMidenClient({ transactions: { executeRequest: staged.executeRequest } });

    // Scope doMocks inside isolateModulesAsync so they don't leak to other
    // tests in this file (Jest's doMock state is per-module-registry).
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('lib/platform', () => ({
          isMobile: () => true,
          isExtension: () => false,
          isDesktop: () => false
        }));
        mockStagedSdk({ TransactionProver: { newCallbackProver, newLocalProver } });
        jest.doMock('@miden/native-prover', () => ({ MidenNativeProver: nativeProverPlugin }));

        const { MidenClientInterface } = await import('./miden-client-interface');
        const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
        const result = await client.consumeNoteId(
          {
            accountId: 'acc-id',
            noteId: 'note-1',
            type: 'consume',
            delegateTransaction: false
          } as any,
          600
        );
        expect(result).toBe(fakeTransactionResult);
      });

      // The mobile branch picks newCallbackProver, not newLocalProver.
      expect(newCallbackProver).toHaveBeenCalledTimes(1);
      expect(newLocalProver).not.toHaveBeenCalled();
      // ...and forwards a function (the callback closure) into it.
      const firstCall = newCallbackProver.mock.calls[0];
      expect(firstCall).toBeDefined();
      expect(typeof firstCall![0]).toBe('function');

      // The staged prove then receives that closure-wrapping prover instance (#1233).
      expect(staged.prove.mock.calls.at(-1)?.[0]?.prover).toBe('callback-prover-instance');
    } finally {
      // jest.doMock persists past jest.resetModules, so undo the mobile and native-prover mocks even
      // when this test fails; otherwise every later test in the file runs with isMobile() true.
      jest.dontMock('lib/platform');
      jest.dontMock('@miden/native-prover');
    }
  });

  it('consumeNoteId surfaces SDK exception with name+message in prove-timing log', async () => {
    const prevFlag = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    delete (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__;

    try {
      mockStagedSdk();

      const consumeErr = new Error('kernel exec failed');
      consumeErr.name = 'TestKernelError';
      const fakeMidenClient = buildFakeMidenClient({
        transactions: { executeRequest: jest.fn().mockRejectedValue(consumeErr) }
      });

      await jest.isolateModulesAsync(async () => {
        const { MidenClientInterface } = await import('./miden-client-interface');
        const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
        await expect(
          client.consumeNoteId({ accountId: 'acc-id', noteId: 'note-1', type: 'consume' } as any, 600)
        ).rejects.toBe(consumeErr);
      });

      const markers = (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__ ?? [];
      expect(markers.some(l => /consumeNoteId staged consume THREW.*TestKernelError.*kernel exec failed/.test(l))).toBe(
        true
      );
    } finally {
      if (prevFlag === undefined) {
        delete process.env.MIDEN_E2E_TEST;
      } else {
        process.env.MIDEN_E2E_TEST = prevFlag;
      }
      delete (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__;
    }
  });

  describe('withProverFallback connectivity-state categorization', () => {
    // Build a client that fails the first (delegate) call with a provided error and
    // succeeds the second (local-prover) call. Returns the connectivity-state spies
    // so the caller can assert whether prover was marked / cleared.
    async function runDelegateFailureCase(err: Error) {
      const markConnectivityIssue = jest.fn();
      const clearConnectivityIssue = jest.fn();
      let call = 0;
      const staged = stagedExecuteRequest(() => {
        call++;
        if (call === 1) throw err;
      });
      const fakeMidenClient = buildFakeMidenClient({ transactions: { executeRequest: staged.executeRequest } });

      mockStagedSdk();
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue,
        clearConnectivityIssue
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const result = await client.consumeNoteId(
        {
          accountId: 'acc-id',
          noteId: 'note-1',
          type: 'consume',
          delegateTransaction: true
        } as any,
        600
      );

      expect(result).toBe(fakeTransactionResult);
      expect(staged.prove).toHaveBeenCalledTimes(2); // delegate attempt + local retry
      return { markConnectivityIssue, clearConnectivityIssue };
    }

    it('does NOT mark prover for "note has already been consumed"', async () => {
      const { markConnectivityIssue } = await runDelegateFailureCase(
        new Error('failed to execute transaction: invalid transaction request: note 0xdead has already been consumed')
      );
      expect(markConnectivityIssue).not.toHaveBeenCalled();
    });

    it('rethrows immediately without local-prover retry when delegateTransaction=false', async () => {
      // shouldDelegate=false → the local-prover-fallback branch is skipped and
      // the error bubbles straight through the `throw err` line.
      const markConnectivityIssue = jest.fn();
      const clearConnectivityIssue = jest.fn();
      const staged = stagedExecuteRequest(() => {
        throw new Error('prover unreachable');
      });
      const fakeMidenClient = buildFakeMidenClient({ transactions: { executeRequest: staged.executeRequest } });

      mockStagedSdk();
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue,
        clearConnectivityIssue
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await expect(
        client.consumeNoteId(
          {
            accountId: 'acc-id',
            noteId: 'note-1',
            type: 'consume',
            delegateTransaction: false
          } as any,
          600
        )
      ).rejects.toThrow('prover unreachable');

      // Called once (no local-prover retry) and banner untouched.
      expect(staged.prove).toHaveBeenCalledTimes(1);
      expect(markConnectivityIssue).not.toHaveBeenCalled();
    });

    it('does NOT mark prover for "invalid transaction request"', async () => {
      const { markConnectivityIssue } = await runDelegateFailureCase(
        new Error('invalid transaction request: something else went wrong')
      );
      expect(markConnectivityIssue).not.toHaveBeenCalled();
    });

    it('DOES mark prover on "Failed to fetch"', async () => {
      const { markConnectivityIssue } = await runDelegateFailureCase(new Error('Failed to fetch'));
      expect(markConnectivityIssue).toHaveBeenCalledWith('prover');
    });

    it('DOES mark prover on 502 Bad Gateway', async () => {
      const { markConnectivityIssue } = await runDelegateFailureCase(
        new Error('prover responded with status code 502: Bad Gateway')
      );
      expect(markConnectivityIssue).toHaveBeenCalledWith('prover');
    });

    it('DOES mark prover on abort / timeout', async () => {
      const { markConnectivityIssue } = await runDelegateFailureCase(new Error('The operation was aborted'));
      expect(markConnectivityIssue).toHaveBeenCalledWith('prover');
    });

    it.each([
      ['NetworkError when attempting to fetch resource'],
      ['grpc network error occurred'],
      ['Load failed'],
      ['request was abort'],
      ['request timed out after 30s'],
      ['timeout waiting for response'],
      ['connection refused'],
      ['transport error: closed stream'],
      ['rpc error: deadline exceeded']
    ])('DOES mark prover for %p', async message => {
      const { markConnectivityIssue } = await runDelegateFailureCase(new Error(message));
      expect(markConnectivityIssue).toHaveBeenCalledWith('prover');
    });

    it.each([['note has already been consumed'], ['some unrecognized wasm error']])(
      'does NOT mark prover for %p',
      async message => {
        const { markConnectivityIssue } = await runDelegateFailureCase(new Error(message));
        expect(markConnectivityIssue).not.toHaveBeenCalled();
      }
    );

    it('clears prover on a successful prover call', async () => {
      const markConnectivityIssue = jest.fn();
      const clearConnectivityIssue = jest.fn();
      const staged = stagedExecuteRequest();
      const fakeMidenClient = buildFakeMidenClient({ transactions: { executeRequest: staged.executeRequest } });

      mockStagedSdk();
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue,
        clearConnectivityIssue
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await client.consumeNoteId(
        {
          accountId: 'acc-id',
          noteId: 'note-1',
          type: 'consume',
          delegateTransaction: true
        } as any,
        600
      );

      expect(markConnectivityIssue).not.toHaveBeenCalled();
      expect(clearConnectivityIssue).toHaveBeenCalledWith('prover');
    });
  });

  describe('staged consume and swap (#1233)', () => {
    const consumeTx = { accountId: 'acc-id', noteId: 'note-1', type: 'consume', delegateTransaction: true };
    const swapTx = {
      accountId: 'acc-id',
      faucetId: 'offered-faucet',
      amount: BigInt(10),
      type: 'swap',
      delegateTransaction: true,
      extraInputs: { requestedFaucetId: 'wanted-faucet', requestedAmount: BigInt(20) }
    };
    const writes: Array<[string, (client: MidenClientInterfaceType) => Promise<unknown>]> = [
      ['consume', client => client.consumeNoteId(consumeTx as any, 600)],
      ['swap', client => client.swapTransaction(swapTx as any, 600)]
    ];

    const stagedClient = async (executeRequest: jest.Mock) => {
      mockStagedSdk();
      const { MidenClientInterface } = await import('./miden-client-interface');
      return MidenClientInterface.fromClient(
        buildFakeMidenClient({
          transactions: { executeRequest },
          __inner: {
            getInputNote: jest.fn(async (id: string) => ({ toNote: () => ({ note: id }) })),
            newConsumeTransactionRequest: jest.fn(async () => ({ serialize: () => new Uint8Array([8]) })),
            newPswapCreateTransactionRequest: jest.fn(() => ({ serialize: () => new Uint8Array([3]) }))
          }
        }) as any,
        'testnet'
      );
    };

    it.each(writes)('%s: a delegated prove that fails falls back to the local prover', async (_write, run) => {
      const staged = stagedExecuteRequest(options => {
        if (options?.prover !== 'local') throw new Error('remote prover deadline exceeded');
      });
      const client = await stagedClient(staged.executeRequest);

      await expect(run(client)).resolves.toBe(fakeTransactionResult);

      expect(staged.prove).toHaveBeenCalledTimes(2);
      expect(staged.prove.mock.calls[1]?.[0]?.prover).toBe('local');
      expect(staged.submit).toHaveBeenCalledTimes(1);
    });

    it.each(writes)('%s: a submit that fails is not re-run locally', async (_write, run) => {
      const refused = new Error('node refused the transaction');
      const staged = stagedExecuteRequest();
      staged.submit.mockRejectedValueOnce(refused);
      const client = await stagedClient(staged.executeRequest);

      await expect(run(client)).rejects.toBe(refused);

      expect(staged.executeRequest).toHaveBeenCalledTimes(1);
      expect(staged.submit).toHaveBeenCalledTimes(1);
    });

    it('a delegated swap whose client was marked poisoned during its prove neither proves locally nor submits', async () => {
      let client: MidenClientInterfaceType | undefined;
      const staged = stagedExecuteRequest(options => {
        if (options?.prover === 'local') return;
        // Recovery marks an evicted flow's client before it hands the mutex on (#775).
        client?.markPoisoned();
        throw new Error('Delegated swap prove timed out after 120000ms waiting for the remote prover');
      });
      client = await stagedClient(staged.executeRequest);
      const { WasmClientPoisonedError } = await import('./wasm-client-poison');

      await expect(client.swapTransaction(swapTx as any, 600)).rejects.toBeInstanceOf(WasmClientPoisonedError);

      expect(staged.prove).toHaveBeenCalledTimes(1);
      expect(staged.submit).not.toHaveBeenCalled();
    });

    it.each(writes)(
      '%s: an apply that fails after the submit carries the landed code and its cause',
      async (_write, run) => {
        const storeAbort = new Error('IndexedDB transaction aborted while applying the transaction update');
        const staged = stagedExecuteRequest();
        staged.apply.mockRejectedValue(storeAbort);
        const client = await stagedClient(staged.executeRequest);
        const { extractSdkErrorCode } = await import('./sdk-error-code');

        const error = await settleThroughApplyRetry(() => run(client));

        expect(extractSdkErrorCode(error)).toBe('ApplyTransactionAfterSubmitFailed');
        expect(error).toHaveProperty('cause', storeAbort);
        expect(staged.executeRequest).toHaveBeenCalledTimes(1);
      }
    );

    it.each<'consume' | 'swap' | 'newTransaction'>(['consume', 'swap', 'newTransaction'])(
      'the staged %s stamps submitting with the evidence, before it submits (#1081)',
      async write => {
        const staged = stagedExecuteRequest();
        const order: string[] = [];
        staged.submit.mockImplementation(async () => {
          order.push('submit');
          return { apply: staged.apply };
        });
        const onStage = jest.fn(async (stage: string) => {
          order.push(`stamp:${stage}`);
        });
        // Under a real hold, since a write that holds none reads no evidence; an earlier test's lock stub would
        // otherwise outlive the module reset.
        jest.dontMock('./miden-client');
        const client = await stagedClient(staged.executeRequest);
        const { withWasmClientLock } = await import('./miden-client');
        await withWasmClientLock(async () => {
          if (write === 'consume') await client.consumeNoteId(consumeTx as any, 600, onStage);
          else if (write === 'swap') await client.swapTransaction(swapTx as any, 600, onStage);
          else await client.newTransaction('acc-id', new Uint8Array([1]), true, onStage);
        });

        expect(onStage).toHaveBeenCalledWith('submitting', {
          evidence: expect.objectContaining({ transactionId: 'tx-hex' })
        });
        expect(order.indexOf('stamp:submitting')).toBeGreaterThan(-1);
        expect(order.indexOf('stamp:submitting')).toBeLessThan(order.indexOf('submit'));
      }
    );
  });

  // Offscreen-prove paths.
  //
  // Each test runs with `MIDEN_USE_OFFSCREEN_PROVING=true` (set before the
  // module is imported, via `process.env`) so `shouldUseOffscreenProver`
  // returns true. We mock `isOffscreenAvailable` to true and stub the
  // proveViaOffscreen + WASM lock surfaces.
  //
  // The mock client carries `_withInnerWebClient` running its callback
  // against a stub `inner` that captures executeTransaction /
  // submitProvenTransaction / applyTransaction calls so we can assert the
  // right pipeline pieces ran.
  describe('proveLocallyViaOffscreen', () => {
    const ORIGINAL_OFFSCREEN_FLAG = process.env.MIDEN_USE_OFFSCREEN_PROVING;

    beforeEach(() => {
      process.env.MIDEN_USE_OFFSCREEN_PROVING = 'true';
    });

    afterEach(() => {
      if (ORIGINAL_OFFSCREEN_FLAG === undefined) {
        delete process.env.MIDEN_USE_OFFSCREEN_PROVING;
      } else {
        process.env.MIDEN_USE_OFFSCREEN_PROVING = ORIGINAL_OFFSCREEN_FLAG;
      }
    });

    function buildOffscreenStubs(opts: { proveViaOffscreen?: jest.Mock } = {}) {
      const isOffscreenAvailable = jest.fn(() => true);
      const proveViaOffscreen =
        opts.proveViaOffscreen ??
        jest.fn(async () => ({
          provenBytes: new Uint8Array([0x99, 0x99]).buffer,
          durationMs: 42
        }));

      jest.doMock('lib/miden/back/offscreen-prover', () => ({
        isOffscreenAvailable,
        proveViaOffscreen
      }));
      jest.doMock('./miden-client', () => ({
        yieldWasmClientLock: async <T>(op: () => Promise<T>) => op(),
        withWasmLockWatchdogPaused: async <T>(op: () => Promise<T>) => op(),
        getCurrentWasmLockHold: () => null
      }));

      return { proveViaOffscreen };
    }

    function buildWasmStub() {
      return {
        TransactionResult: {
          deserialize: jest.fn(() => fakeTransactionResult)
        },
        ProvenTransaction: {
          deserialize: jest.fn(() => 'fake-proven')
        },
        AccountId: {
          fromHex: jest.fn((id: string) => ({ tag: 'hex', id })),
          fromBech32: jest.fn((id: string) => ({ tag: 'bech32', id }))
        },
        NoteType: { Public: 'Public', Private: 'Private' }
      };
    }

    function buildClientWithInner(inner: any, fakeWasm: any) {
      const fakeMidenClient = buildFakeMidenClient();
      // The proveLocallyViaOffscreen path runs its critical sections via
      // `_withInnerWebClient(fn)` — install a stub that runs `fn` against
      // a tracker so the test can assert submitProvenTransaction +
      // applyTransaction were called in order.
      (fakeMidenClient as any)._withInnerWebClient = async (fn: any) => fn(inner);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) }
      }));
      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
        buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) })),
        buildConsumeTransactionRequest: jest.fn((_notes: unknown[], _expirationDelta: number) => ({
          kind: 'consume-request'
        }))
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));
      return fakeMidenClient;
    }

    it('runs execute, offscreen prove, submit and apply', async () => {
      const fakeWasm = buildWasmStub();
      const inner = {
        executeTransaction: jest.fn(async () => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => undefined),
        getAccount: jest.fn(async () => undefined)
      };
      const stubs = buildOffscreenStubs();
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await client.sendTransaction(
        {
          accountId: 'sender',
          secondaryAccountId: 'recip',
          faucetId: 'faucet',
          noteType: 'public' as any,
          amount: BigInt(100),
          extraInputs: {}
        } as any,
        600
      );

      expect(inner.executeTransaction).toHaveBeenCalledTimes(1);
      expect(stubs.proveViaOffscreen).toHaveBeenCalledTimes(1);
      expect(inner.submitProvenTransaction).toHaveBeenCalledTimes(1);
      expect(inner.applyTransaction).toHaveBeenCalledTimes(1);
    });

    it('stamps submitting with the evidence of the offscreen proof, before it submits (#1081)', async () => {
      const fakeWasm = buildWasmStub();
      const order: string[] = [];
      const inner = {
        executeTransaction: jest.fn(async () => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => {
          order.push('submit');
          return 100;
        }),
        applyTransaction: jest.fn(async () => undefined),
        getAccount: jest.fn(async () => undefined)
      };
      buildOffscreenStubs();
      // The write still owns the hold it took, so its leaf reads the evidence.
      const hold = {};
      jest.doMock('./miden-client', () => ({
        yieldWasmClientLock: async <T>(op: () => Promise<T>) => op(),
        withWasmLockWatchdogPaused: async <T>(op: () => Promise<T>) => op(),
        getCurrentWasmLockHold: () => hold
      }));
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));
      const onStage = jest.fn(async (stage: string) => {
        order.push(`stamp:${stage}`);
      });

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
      await client.sendTransaction(
        {
          accountId: 'sender',
          secondaryAccountId: 'recip',
          faucetId: 'faucet',
          noteType: 'public' as any,
          amount: BigInt(100),
          extraInputs: {}
        } as any,
        600,
        onStage
      );

      expect(onStage).toHaveBeenCalledWith('submitting', {
        evidence: expect.objectContaining({ transactionId: 'tx-hex' })
      });
      expect(order).toEqual(['stamp:executing', 'stamp:proving', 'stamp:submitting', 'submit']);
    });

    it('skips the mutex yield once the client is disposed — an evicted corpse must not release a lock it no longer owns', async () => {
      const fakeWasm = buildWasmStub();
      const inner = {
        executeTransaction: jest.fn(async () => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => undefined),
        getAccount: jest.fn(async () => undefined)
      };
      const stubs = buildOffscreenStubs();
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));
      // Lock recovery (issue #775) disposes the client BEFORE releasing the
      // mutex, so `disposed` marks this flow as evicted; yielding would hand
      // back a lock that now belongs to the next holder.
      const yieldMock = jest.fn(async (op: () => Promise<unknown>) => op());
      jest.doMock('./miden-client', () => ({
        yieldWasmClientLock: yieldMock,
        withWasmLockWatchdogPaused: async <T>(op: () => Promise<T>) => op(),
        getCurrentWasmLockHold: () => null
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
      client.free();

      await client.sendTransaction(
        {
          accountId: 'sender',
          secondaryAccountId: 'recip',
          faucetId: 'faucet',
          noteType: 'public' as any,
          amount: BigInt(100),
          extraInputs: {}
        } as any,
        600
      );

      expect(stubs.proveViaOffscreen).toHaveBeenCalledTimes(1);
      expect(yieldMock).not.toHaveBeenCalled();
    });

    it.each([
      ['a Never send', {}, undefined],
      // The fake client syncs to block 5, so a 600-block window reclaims at 605 (#308).
      ['a reclaimable send', { recallBlocks: 600 }, 605]
    ])(
      "builds %s's request from the sender's account, resolved ids and reclaim height",
      async (_label, extraInputs, reclaimAfter) => {
        const fakeWasm = buildWasmStub();
        // A marker account, NOT undefined: the sender's vault key (callback flag
        // included) has to reach the builder. With `undefined` the builder falls
        // through to `new FungibleAsset(...)` and its default Disabled flag.
        const senderAccount = { tag: 'sender-account' };
        const inner = {
          executeTransaction: jest.fn(async () => fakeTransactionResult),
          submitProvenTransaction: jest.fn(async () => 100),
          applyTransaction: jest.fn(async () => undefined),
          getAccount: jest.fn(async () => senderAccount)
        };
        buildOffscreenStubs();
        const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
        const buildSendTransactionRequest = jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }));
        jest.doMock('./helpers', () => ({
          getBech32AddressFromAccountId: (id: any) => String(id),
          walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
          accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
          buildSendTransactionRequest
        }));
        jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
          ...fakeWasm,
          TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
          TransactionRequest: { deserialize: jest.fn(() => ({})) },
          getWasmOrThrow: async () => fakeWasm
        }));

        const { MidenClientInterface } = await import('./miden-client-interface');
        const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

        await client.sendTransaction(
          {
            // Composite `<address>_<suffix>` sender: `resolveAccountId` must strip the
            // suffix before parsing, or the bech32 parser sees a string it can reject.
            accountId: 'mtst1sender_qr7qqq9wr6w',
            // Uppercase '0X' too: `AccountId.fromHex` throws on it, so a reference
            // that is otherwise valid would fail to resolve here.
            secondaryAccountId: '0XRecipient',
            faucetId: 'mtst1faucet',
            noteType: 'private' as any,
            amount: BigInt(250),
            extraInputs
          } as any,
          600
        );

        expect(fakeWasm.AccountId.fromBech32).toHaveBeenCalledWith('mtst1sender');
        expect(fakeWasm.AccountId.fromHex).toHaveBeenCalledWith('0xRecipient');
        expect(inner.getAccount).toHaveBeenCalled();
        expect(buildSendTransactionRequest).toHaveBeenCalledWith(
          senderAccount,
          expect.anything(),
          expect.anything(),
          'mtst1faucet',
          250n,
          'Private',
          600,
          reclaimAfter
        );
        expect(inner.submitProvenTransaction).toHaveBeenCalledTimes(1);
      }
    );

    it('consumeNoteId offscreen path: builds the request from inner.getInputNote → toNote and the delta', async () => {
      const fakeWasm = buildWasmStub();
      const note = { kind: 'note' };
      const inputNoteRecord = { toNote: jest.fn(() => note) };
      const inner = {
        getInputNote: jest.fn(async () => inputNoteRecord),
        newConsumeTransactionRequest: jest.fn(async (_notes: unknown[], _account: unknown) => ({ kind: 'request' })),
        executeTransaction: jest.fn(async (_accountId: unknown, _request: unknown) => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => undefined)
      };
      const stubs = buildOffscreenStubs({});
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await client.consumeNoteId(
        {
          accountId: 'mtst1acc',
          noteId: 'note-id-123',
          type: 'consume'
        } as any,
        600
      );

      expect(inner.getInputNote).toHaveBeenCalledWith('note-id-123');
      expect(inputNoteRecord.toNote).toHaveBeenCalledTimes(1);
      const { buildConsumeTransactionRequest } = jest.requireMock('./helpers');
      expect(buildConsumeTransactionRequest).toHaveBeenCalledWith([note], 600);
      expect(inner.newConsumeTransactionRequest).not.toHaveBeenCalled();
      // The builder's request is the one executed, on the resolved account.
      expect(inner.executeTransaction).toHaveBeenCalledWith(
        { tag: 'bech32', id: 'mtst1acc' },
        buildConsumeTransactionRequest.mock.results[0]?.value
      );
      // Then through the offscreen pipeline.
      expect(stubs.proveViaOffscreen).toHaveBeenCalledTimes(1);
      expect(inner.submitProvenTransaction).toHaveBeenCalledTimes(1);
      expect(inner.applyTransaction).toHaveBeenCalledTimes(1);
    });

    it('consumeNoteId offscreen path: throws when getInputNote returns null', async () => {
      const fakeWasm = buildWasmStub();
      const inner = {
        getInputNote: jest.fn(async () => null),
        newConsumeTransactionRequest: jest.fn(),
        executeTransaction: jest.fn(),
        submitProvenTransaction: jest.fn(),
        applyTransaction: jest.fn()
      };
      buildOffscreenStubs({});
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await expect(
        client.consumeNoteId(
          {
            accountId: 'mtst1acc',
            noteId: 'missing-note',
            type: 'consume'
          } as any,
          600
        )
      ).rejects.toThrow(/Note missing-note not found in store/);
    });

    // The claim's offscreen-proved leg applies through the same wrap as the other writes (#1233), so a
    // claim the node accepted whose apply fails reports as submitted and the loop catch completes it.
    it('consumeNoteId offscreen path: an apply that fails after the submit rejects as ApplyAfterSubmitError (#1233)', async () => {
      const fakeWasm = buildWasmStub();
      const storeAbort = new Error('IndexedDB transaction aborted while applying the transaction update');
      const inner = {
        getInputNote: jest.fn(async () => ({ toNote: () => ({ kind: 'note' }) })),
        newConsumeTransactionRequest: jest.fn(async (_notes: unknown[], _account: unknown) => ({ kind: 'request' })),
        executeTransaction: jest.fn(async (_accountId: unknown, _request: unknown) => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => Promise.reject(storeAbort)),
        getAccount: jest.fn(async () => undefined)
      };
      buildOffscreenStubs({});
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const { ApplyAfterSubmitError } = await import('./sdk-error-code');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const error = await settleThroughApplyRetry(() =>
        client.consumeNoteId({ accountId: 'mtst1acc', noteId: 'note-id-123', type: 'consume' } as any, 600)
      );

      expect(error).toBeInstanceOf(ApplyAfterSubmitError);
      expect(error).toHaveProperty('cause', storeAbort);
      expect(inner.executeTransaction).toHaveBeenCalledTimes(1);
      expect(inner.submitProvenTransaction).toHaveBeenCalledTimes(1);
    });

    it('newTransaction offscreen path: deserializes a fresh request and runs the offscreen pipeline', async () => {
      const fakeWasm = buildWasmStub();
      const inner = {
        executeTransaction: jest.fn(async () => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => undefined)
      };
      const stubs = buildOffscreenStubs({});
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      const txRequestDeserialize = jest.fn(() => ({ kind: 'fresh-request' }));
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: txRequestDeserialize },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const requestBytes = new Uint8Array([0xde, 0xad]);
      await client.newTransaction('mtst1acc', requestBytes);

      // Exactly one deserialize: the one inside proveLocallyViaOffscreen's builder
      // closure. `newTransaction` no longer deserializes eagerly at the top of the
      // method — a wasm-bindgen request is consumed by execution, so each attempt
      // now hydrates its own from the bytes.
      expect(txRequestDeserialize).toHaveBeenCalledTimes(1);
      expect(stubs.proveViaOffscreen).toHaveBeenCalledTimes(1);
      expect(inner.submitProvenTransaction).toHaveBeenCalledTimes(1);
    });

    it('rethrows a trap from the prover descriptor instead of proving on the trapped client', async () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      const fakeWasm = buildWasmStub();
      const inner = {
        executeTransaction: jest.fn(async () => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => undefined),
        getAccount: jest.fn(async () => undefined),
        newSendTransactionRequest: jest.fn(async () => ({}))
      };
      const stubs = buildOffscreenStubs();
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: {
          newLocalProver: jest.fn(() => ({
            serialize: () => {
              throw trap;
            }
          }))
        },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await expect(
        client.sendTransaction(
          {
            accountId: 'sender',
            secondaryAccountId: 'recip',
            faucetId: 'faucet',
            noteType: 'public' as any,
            amount: BigInt(100),
            extraInputs: {}
          } as any,
          600
        )
      ).rejects.toBe(trap);
      expect(stubs.proveViaOffscreen).not.toHaveBeenCalled();
      expect(inner.executeTransaction).not.toHaveBeenCalled();
    });

    it('throws and logs when proveLocallyViaOffscreen pipeline fails', async () => {
      const fakeWasm = buildWasmStub();
      const inner = {
        executeTransaction: jest.fn(async () => {
          throw new Error('execute failed');
        }),
        submitProvenTransaction: jest.fn(),
        applyTransaction: jest.fn(),
        getAccount: jest.fn(async () => undefined)
      };
      buildOffscreenStubs({});
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await expect(
        client.sendTransaction(
          {
            accountId: 'sender',
            secondaryAccountId: 'recip',
            faucetId: 'faucet',
            noteType: 'public' as any,
            amount: BigInt(100),
            extraInputs: {}
          } as any,
          600
        )
      ).rejects.toThrow(/execute failed/);
    });

    it('reports an apply that fails after the offscreen-proved submit as submitted, with the store error as its cause (#1233)', async () => {
      const fakeWasm = buildWasmStub();
      const storeAbort = new Error('IndexedDB transaction aborted while applying the transaction update');
      const inner = {
        executeTransaction: jest.fn(async () => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => Promise.reject(storeAbort)),
        getAccount: jest.fn(async () => undefined)
      };
      buildOffscreenStubs();
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const { extractSdkErrorCode } = await import('./sdk-error-code');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const error = await settleThroughApplyRetry(() =>
        client.newTransaction('mtst1acc', new Uint8Array([0xde, 0xad]))
      );

      expect(inner.submitProvenTransaction).toHaveBeenCalledTimes(1);
      expect(extractSdkErrorCode(error)).toBe('ApplyTransactionAfterSubmitFailed');
      expect(error).toHaveProperty('cause', storeAbort);
    });
  });

  describe('importNoteBytes', () => {
    // Builds a MidenClientInterface with the SDK's note (de)serialization mocked,
    // so we can drive importNoteBytes down each branch. Mirrors the doMock scaffold
    // used by the smoke test above.
    async function setup(sdk: {
      noteFileDeserialize: jest.Mock;
      noteDeserialize: jest.Mock;
      fromExpectedNote?: jest.Mock;
    }) {
      const fakeMidenClient = buildFakeMidenClient();
      const importMock = fakeMidenClient.notes.import as jest.Mock;
      // Only `fromExpectedNote` is exposed: `fromNoteDetails` is the
      // zero-valued-sync-hint constructor whose tag-0 file can never commit, so
      // a regression back to it must fail loudly here rather than silently
      // import an unclaimable note.
      const fromExpectedNote =
        sdk.fromExpectedNote ??
        jest.fn((details: any, tag: any, afterBlockNum: number) => ({
          kind: 'from-details',
          details,
          tag,
          afterBlockNum
        }));
      const NoteDetailsCtor = jest.fn(function (this: any, assets: any, recipient: any) {
        this.assets = assets;
        this.recipient = recipient;
      });

      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        NoteType: { Private: 0, Public: 1 },
        MidenClient: { create: jest.fn(async () => fakeMidenClient) },
        NoteFile: { deserialize: sdk.noteFileDeserialize, fromExpectedNote },
        Note: { deserialize: sdk.noteDeserialize },
        NoteDetails: NoteDetailsCtor,
        AccountFile: { deserialize: jest.fn(() => ({})) },
        NoteExportFormat: { Id: 'Id', Full: 'Full', Details: 'Details' },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        TransactionProver: { newRemoteProver: jest.fn(), newLocalProver: jest.fn() },
        exportStore: jest.fn(),
        importStore: jest.fn()
      }));
      jest.doMock('lib/miden-chain/effective-endpoints', () => ({
        getEffectiveNetworkName: () => 'localnet',
        getEffectiveRpcUrl: () => 'rpc-local',
        getEffectiveProverUrl: () => undefined,
        getEffectiveNoteTransportUrl: () => undefined
      }));
      jest.doMock('./constants', () => ({ NoteExportType: {} }));
      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        canonicalWalletAccountId: (id: string) => `sdk-${id.split('_')[0] ?? id}`,
        buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
      }));
      jest.doMock('../helpers', () => ({
        ...jest.requireActual('../helpers'),
        getNoteRecallableAtMs: jest.fn(() => undefined),
        toNoteType: jest.fn()
      }));
      jest.doMock('../db/types', () => ({ ConsumeTransaction: class {}, SendTransaction: class {} }));
      jest.doMock('screens/onboarding/types', () => ({ WalletType: { OnChain: 'on-chain', OffChain: 'off-chain' } }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = await MidenClientInterface.create({
        seed: new Uint8Array([1, 2, 3]),
        insertKeyCallback: jest.fn()
      });
      return { client, importMock, fromExpectedNote, NoteDetailsCtor };
    }

    it('imports serialized NoteFile bytes directly without touching the Note fallback', async () => {
      const noteFileDeserialize = jest.fn(() => ({ kind: 'notefile' }));
      const noteDeserialize = jest.fn();
      const { client, importMock } = await setup({ noteFileDeserialize, noteDeserialize });

      await client.importNoteBytes(new Uint8Array([1, 2]), NO_HOLD);

      expect(noteFileDeserialize).toHaveBeenCalled();
      expect(noteDeserialize).not.toHaveBeenCalled();
      expect(importMock).toHaveBeenCalledWith({ kind: 'notefile' });
    });

    it('wraps a serialized Note (e.g. note.serialize()) into a NoteFile and imports it', async () => {
      const noteFileDeserialize = jest.fn(() => {
        throw new Error('notefile deserialization failed: invalid utf-8 sequence of 1 bytes from index 1');
      });
      const fakeNote = {
        assets: jest.fn(() => 'note-assets'),
        recipient: jest.fn(() => 'note-recipient'),
        metadata: jest.fn(() => ({ tag: () => 'note-tag-1241513984' }))
      };
      const noteDeserialize = jest.fn(() => fakeNote);
      const fromExpectedNote = jest.fn((details: any, tag: any) => ({ kind: 'wrapped', details, tag }));
      const { client, importMock, NoteDetailsCtor } = await setup({
        noteFileDeserialize,
        noteDeserialize,
        fromExpectedNote
      });

      await client.importNoteBytes(new Uint8Array([9, 9, 9]), NO_HOLD);

      expect(noteDeserialize).toHaveBeenCalled();
      // NoteDetails built from the note's assets + recipient, then wrapped.
      expect(NoteDetailsCtor).toHaveBeenCalledWith('note-assets', 'note-recipient');
      expect(fromExpectedNote).toHaveBeenCalled();
      expect(importMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wrapped' }));
    });

    /**
     * A NoteFile's tag is what makes an imported expected note resolvable: the
     * client asks the node for the notes carrying that tag and subscribes to it.
     * Wrapping with the SDK's zero-valued sync hint (`NoteFile.fromNoteDetails`)
     * produced tag 0, which no real note carries — so a private note that was
     * already committed on chain stayed `Expected` forever: never in the
     * claimable list, never consumable, and leaving a dead tag-0 subscription on
     * every later sync.
     */
    it("wraps a bare Note with the note's OWN tag, not a zero-valued sync hint", async () => {
      const noteFileDeserialize = jest.fn(() => {
        throw new Error('notefile deserialization failed: invalid utf-8 sequence of 1 bytes from index 2');
      });
      const noteTag = { value: 1241513984 };
      const metadata = jest.fn(() => ({ tag: () => noteTag }));
      const noteDeserialize = jest.fn(() => ({
        assets: jest.fn(() => 'note-assets'),
        recipient: jest.fn(() => 'note-recipient'),
        metadata
      }));
      const { client, importMock, fromExpectedNote } = await setup({ noteFileDeserialize, noteDeserialize });

      await client.importNoteBytes(new Uint8Array([9, 9, 9]), NO_HOLD);

      expect(metadata).toHaveBeenCalled();
      const [, tagArg, afterBlockArg] = fromExpectedNote.mock.calls[0]!;
      expect(tagArg).toBe(noteTag);
      // A bare Note carries no block information, so the scan starts at genesis.
      expect(afterBlockArg).toBe(0);
      expect(importMock).toHaveBeenCalledWith(expect.objectContaining({ tag: noteTag, afterBlockNum: 0 }));
    });

    it('throws a clear, actionable error when bytes are neither a NoteFile nor a Note', async () => {
      const noteFileDeserialize = jest.fn(() => {
        throw new Error('notefile deserialization failed');
      });
      const noteDeserialize = jest.fn(() => {
        throw new Error('note deserialization failed');
      });
      const { client, importMock } = await setup({ noteFileDeserialize, noteDeserialize });

      await expect(client.importNoteBytes(new Uint8Array([0]), NO_HOLD)).rejects.toThrow(
        /neither a serialized NoteFile nor a serialized Note/
      );
      expect(importMock).not.toHaveBeenCalled();
    });

    it('stringifies non-Error throwables when reporting the neither-NoteFile-nor-Note error', async () => {
      // Deserializers can throw non-Error values; the error message must still
      // surface their details via String(...) rather than printing [object].
      // Throw through an indirection so the intentional non-Error throw doesn't
      // trip eslint's no-throw-literal.
      const reject = (value: unknown) => {
        throw value;
      };
      const noteFileDeserialize = jest.fn(() => reject('raw-notefile-failure'));
      const noteDeserialize = jest.fn(() => reject('raw-note-failure'));
      const { client, importMock } = await setup({ noteFileDeserialize, noteDeserialize });

      await expect(client.importNoteBytes(new Uint8Array([0]), NO_HOLD)).rejects.toThrow(
        /NoteFile parse error: raw-notefile-failure; Note parse error: raw-note-failure/
      );
      expect(importMock).not.toHaveBeenCalled();
    });
  });

  // These cases register narrow jest.doMock surfaces, which survive jest.resetModules(). Each goes through
  // readerDoMock, and the afterEach below undoes exactly what was registered (as the native-prover test above
  // does by hand), so the block need not stay last in the file.
  const fromBech32 = jest.fn((accountId: string) => ({ accountId }));
  const readerSpies: jest.SpyInstance[] = [];
  const readerMocks = new Set<string>();
  const readerDoMock = (specifier: string, factory: () => unknown) => {
    readerMocks.add(specifier);
    jest.doMock(specifier, factory);
  };
  afterEach(() => {
    for (const spy of readerSpies.splice(0)) spy.mockRestore();
    for (const specifier of readerMocks) jest.dontMock(specifier);
    readerMocks.clear();
  });
  async function importWithReader(createClient: jest.Mock, getRpcUrl: () => string = () => 'https://rpc.example') {
    // The real backoff curve with no jitter, on a test clock (as the sync-backoff tests drive it).
    const clock = { now: 0 };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    readerSpies.push(
      jest.spyOn(performance, 'now').mockImplementation(() => clock.now),
      jest.spyOn(Math, 'random').mockReturnValue(0),
      warn
    );
    readerDoMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
      getWasmOrThrow: jest.fn(async () => ({
        AccountId: { fromBech32, fromHex: jest.fn() }
      })),
      WasmWebClient: { createClient }
    }));
    readerDoMock('lib/miden-chain/effective-endpoints', () => ({
      getEffectiveNetworkName: () => 'testnet',
      getEffectiveRpcUrl: () => getRpcUrl(),
      getEffectiveProverUrl: () => undefined,
      getEffectiveNoteTransportUrl: () => undefined
    }));
    readerDoMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));
    const { MidenClientInterface } = await import('./miden-client-interface');
    const { bumpWasmClientGeneration } = await import('./wasm-client-poison');
    const makeClient = (getSyncHeight: jest.Mock = jest.fn(async () => 10)): MidenClientInterfaceType =>
      Reflect.apply(MidenClientInterface.fromClient, MidenClientInterface, [
        buildFakeMidenClient({ getSyncHeight }),
        'testnet'
      ]);
    return { makeClient, bumpWasmClientGeneration, clock, log: logSpy, warn };
  }
  const emptyReader = () => ({ getConsumableNotes: jest.fn(async () => []) });
  // The reader's own lines on a console spy: 'building' for its builds, 'build ' for how a build settled.
  const readerLines = (spy: jest.SpyInstance, kind: 'building' | 'build ') =>
    spy.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith(`[realm-reader] ${kind}`));

  it('filters notes gated beyond the sync height through ONE reader per realm, shared across interfaces', async () => {
    const currentlyConsumable = { id: 'currently-consumable' };
    const ungated = { id: 'ungated' };
    const futureGated = { id: 'future-gated' };
    const consumableRecord = (note: object, consumableAfterBlock: number | undefined) => ({
      inputNoteRecord: () => note,
      noteConsumability: () => [
        {
          consumptionStatus: () => ({
            consumableAfterBlock: () => consumableAfterBlock
          })
        }
      ]
    });
    const getConsumableNotes = jest.fn(async () => [
      consumableRecord(futureGated, 11),
      consumableRecord(currentlyConsumable, 10),
      consumableRecord(ungated, undefined)
    ]);
    const createClient = jest.fn(async () => ({ getConsumableNotes }));
    const { makeClient, log } = await importWithReader(createClient);

    const first = makeClient();
    await expect(first.getConsumableNotes('mtst1account')).resolves.toEqual([currentlyConsumable, ungated]);
    // An inline signed write replaces the interface, not the realm's reader (#868).
    first.free();
    const second = makeClient();
    await expect(second.getConsumableNotes('mtst1account')).resolves.toEqual([currentlyConsumable, ungated]);
    expect(createClient).toHaveBeenCalledTimes(1);
    // The trailing `false` is `useWorker` (the SDK's 6th positional parameter, which
    // defaults to TRUE). Only an MV3 service worker lacks `Worker`; the offscreen
    // document, mobile WebViews and the desktop webview would otherwise spawn a Web
    // Worker plus a second WASM instance for the reader.
    expect(createClient).toHaveBeenCalledWith('https://rpc.example', undefined, undefined, undefined, undefined, false);
    expect(fromBech32).toHaveBeenCalledWith('mtst1account');
    expect(getConsumableNotes).toHaveBeenCalledWith({ accountId: 'mtst1account' });
    // One build line for the realm, however many interfaces read through it.
    const builds = readerLines(log, 'building');
    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain('(first build)');
    expect(builds[0]).toContain(' at rpc.example');
    expect(builds[0]).not.toContain('strands');
  });

  it('rebuilds the reader after a client replacement, and only then', async () => {
    const createClient = jest.fn(async () => emptyReader());
    const { makeClient, bumpWasmClientGeneration, log } = await importWithReader(createClient);
    const client = makeClient();

    await client.getConsumableNotes('mtst1account');
    bumpWasmClientGeneration();
    await client.getConsumableNotes('mtst1account');
    expect(createClient).toHaveBeenCalledTimes(2);
    await client.getConsumableNotes('mtst1account');
    expect(createClient).toHaveBeenCalledTimes(2);
    const builds = readerLines(log, 'building');
    expect(builds).toHaveLength(2);
    expect(builds[0]).toContain('(first build)');
    expect(builds[1]).toContain('(client replaced)');
    expect(builds[1]).toContain('it strands the previous reader (generation ');
  });

  it('rebuilds the reader when the RPC endpoint changes without a client replacement', async () => {
    let rpcUrl = 'https://rpc-a.example';
    const createClient = jest.fn(async () => emptyReader());
    const { makeClient, bumpWasmClientGeneration, log } = await importWithReader(createClient, () => rpcUrl);
    const client = makeClient();

    await client.getConsumableNotes('mtst1account');
    // The offscreen document, mobile and desktop repoint without bumping the generation.
    rpcUrl = 'https://rpc-b.example';
    await client.getConsumableNotes('mtst1account');
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenLastCalledWith(
      'https://rpc-b.example',
      undefined,
      undefined,
      undefined,
      undefined,
      false
    );
    const builds = readerLines(log, 'building');
    expect(builds).toHaveLength(2);
    expect(builds[1]).toContain('(endpoint changed)');
    expect(builds[1]).toContain(' at rpc-b.example');
    expect(builds[1]).toMatch(/it strands the previous reader \(generation \d+ at rpc-a\.example\)$/);
    // The SW's endpoint reload replaces the client and repoints it together: the line names both.
    bumpWasmClientGeneration();
    rpcUrl = 'https://rpc-c.example';
    await client.getConsumableNotes('mtst1account');
    expect(readerLines(log, 'building')[2]).toContain('(client replaced and endpoint changed)');
  });

  it('logs only the host of the endpoint, never its credentials, path or query', async () => {
    let rpcUrl = 'https://user:secret@rpc.example:8443/v1/node?key=secret';
    const createClient = jest.fn(async () => emptyReader());
    const { makeClient, log } = await importWithReader(createClient, () => rpcUrl);
    const client = makeClient();

    await client.getConsumableNotes('mtst1account');
    rpcUrl = 'not a url';
    await client.getConsumableNotes('mtst1account');
    const builds = readerLines(log, 'building');
    expect(builds).toHaveLength(2);
    expect(builds[0]).toContain(' at rpc.example:8443');
    expect(builds.join('\n')).not.toMatch(/secret|user|\/v1|key=/);
    expect(builds[1]).toContain(' at <unparsable endpoint>');
  });

  it('getConsumableNoteDtos applies the SAME reclaim gate, then reduces the survivors to DTOs', async () => {
    // Live-record-shaped survivors so the reducer can reach through them.
    const liveRecord = (id: string) => ({
      id: () => ({ toString: () => id }),
      nullifier: () => `null-${id}`,
      metadata: () => ({ sender: () => `sender-${id}`, noteType: () => 1 }),
      state: () => 2,
      details: () => ({
        assets: () => ({
          fungibleAssets: () => [{ faucetId: () => `faucet-${id}`, amount: () => ({ toString: () => '100' }) }]
        })
      }),
      attachments: () => []
    });
    const consumableRecord = (note: object, consumableAfterBlock: number | undefined) => ({
      inputNoteRecord: () => note,
      noteConsumability: () => [{ consumptionStatus: () => ({ consumableAfterBlock: () => consumableAfterBlock }) }]
    });
    const kept = liveRecord('kept');
    const gated = liveRecord('gated');
    const getConsumableNotes = jest.fn(async () => [
      consumableRecord(gated, 11), // gated beyond sync height 10 → filtered
      consumableRecord(kept, 10) // 10 <= 10 → kept
    ]);
    const createClient = jest.fn(async () => ({ getConsumableNotes }));
    // The reducer bech32-encodes account ids; stub to a recognizable transform (registered before the import).
    readerDoMock('./helpers', () => ({
      ...jest.requireActual('./helpers'),
      getBech32AddressFromAccountId: (accountId: unknown) => `bech32(${String(accountId)})`
    }));
    const { makeClient } = await importWithReader(createClient);
    const client = makeClient();

    // Only the kept (non-gated) note survives, reduced to a full DTO.
    await expect(client.getConsumableNoteDtos('mtst1account')).resolves.toEqual([
      {
        noteId: 'kept',
        nullifier: 'null-kept',
        noteType: 1,
        senderAccountId: 'bech32(sender-kept)',
        state: 2,
        assets: [{ amount: '100', faucetId: 'bech32(faucet-kept)' }],
        swapAttachment: null,
        // The fixture record has no readable script.
        standardPayment: false
      }
    ]);
  });

  // An evicted consumability read must neither reach the realm reader nor list through one
  // it acquired across a parking build (F-022, F-024). `evicted` stands in for the hold
  // passing to a successor; assertLive throws once it is set, as the callers' checks do.
  const evictable = () => {
    const state = { evicted: false };
    const assertLive = jest.fn(() => {
      if (state.evicted) throw new Error('hold evicted');
    });
    return { state, assertLive };
  };

  it('does not reach the reader when the hold is evicted during the height read', async () => {
    const createClient = jest.fn(async () => emptyReader());
    const { makeClient } = await importWithReader(createClient);
    const { state, assertLive } = evictable();
    const getSyncHeight = jest.fn(async () => {
      state.evicted = true;
      return 10;
    });

    await expect(makeClient(getSyncHeight).getConsumableNoteDtos('mtst1account', assertLive)).rejects.toThrow(
      'hold evicted'
    );
    expect(getSyncHeight).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(assertLive.mock.calls).toEqual([['after the sync-height read']]);
  });

  it('does not list through a reader whose build outlived the hold', async () => {
    const { state, assertLive } = evictable();
    const reader = emptyReader();
    const createClient = jest.fn(async () => {
      state.evicted = true; // the first build parks on a genesis fetch; the watchdog fires meanwhile
      return reader;
    });
    const { makeClient } = await importWithReader(createClient);

    await expect(makeClient().getConsumableNoteDtos('mtst1account', assertLive)).rejects.toThrow('hold evicted');
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(reader.getConsumableNotes).not.toHaveBeenCalled();
    expect(assertLive.mock.calls).toEqual([['after the sync-height read'], ['after the reader build']]);
  });

  it('stops before the second height read when the hold is evicted during the listing', async () => {
    const { state, assertLive } = evictable();
    const createClient = jest.fn(async () => ({
      getConsumableNotes: jest.fn(async () => {
        state.evicted = true;
        return [];
      })
    }));
    const { makeClient } = await importWithReader(createClient);
    const getSyncHeight = jest.fn(async () => 10);

    await expect(makeClient(getSyncHeight).getConsumableNoteDtos('mtst1account', assertLive)).rejects.toThrow(
      'hold evicted'
    );
    expect(getSyncHeight).toHaveBeenCalledTimes(1);
    // Each check names the await it follows, so the eviction message says which one parked.
    expect(assertLive.mock.calls).toEqual([
      ['after the sync-height read'],
      ['after the reader build'],
      ['after the listing']
    ]);
  });

  it('backs off a failed reader build instead of rebuilding on every read', async () => {
    const createClient = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockImplementation(async () => emptyReader());
    const { makeClient, clock, log, warn } = await importWithReader(createClient);
    const client = makeClient();

    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    // A failed build may have stranded its store connection, so inside the window there is no new build.
    clock.now += 29_999;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await expect(client.getConsumableNotes('mtst1account')).resolves.toEqual([]);
    expect(createClient).toHaveBeenCalledTimes(2);
    // One warn for the failed build, naming its window and carrying the error; the read served from the window adds
    // none. The build that ended the window says why it ran, and that it ended the streak.
    expect(readerLines(warn, 'build ')).toEqual([expect.stringContaining('failed (1 in a row) - next build in 30s')]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[realm-reader]'),
      expect.objectContaining({ message: 'rpc down' })
    );
    const builds = readerLines(log, 'building');
    expect(builds).toHaveLength(2);
    expect(builds[1]).toContain('(backoff window ended)');
    // The build it replaces had failed, so there was no reader to strand.
    expect(builds[1]).toContain(' - replacing the previous build (generation ');
    expect(builds[1]).not.toContain('strands');
    expect(readerLines(log, 'build ')).toEqual([expect.stringContaining('succeeded (failed builds before it: 1)')]);
  });

  it('lengthens the backoff on consecutive failures up to the sync breaker cap', async () => {
    const createClient = jest.fn(async () => {
      throw new Error('rpc down');
    });
    const { makeClient, clock, warn } = await importWithReader(createClient);
    const client = makeClient();

    // The breaker's curve for an ordinary failure: doubling to the 5 min cap, which then repeats. Never the 30 min
    // fuse, which is for a call that never answered.
    const windows = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];
    for (const [index, windowMs] of windows.entries()) {
      await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
      expect(createClient).toHaveBeenCalledTimes(index + 1);
      clock.now += windowMs - 1;
      await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
      expect(createClient).toHaveBeenCalledTimes(index + 1);
      clock.now += 1;
    }
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(windows.length + 1);
    expect(readerLines(warn, 'build ')).toEqual(
      [...windows, 300_000].map((windowMs, index) =>
        expect.stringContaining(`failed (${index + 1} in a row) - next build in ${windowMs / 1000}s`)
      )
    );
  });

  it('builds at once after a client replacement or a repoint, even inside the backoff', async () => {
    let rpcUrl = 'https://rpc-a.example';
    const createClient = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockImplementation(async () => emptyReader());
    const { makeClient, bumpWasmClientGeneration } = await importWithReader(createClient, () => rpcUrl);
    const client = makeClient();

    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    bumpWasmClientGeneration();
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(2);
    rpcUrl = 'https://rpc-b.example';
    await expect(client.getConsumableNotes('mtst1account')).resolves.toEqual([]);
    expect(createClient).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['a client replacement', 'generation'],
    ['a repoint', 'url']
  ])('a failure after %s starts from the first backoff window', async (_label, change) => {
    let rpcUrl = 'https://rpc-a.example';
    const createClient = jest.fn(async () => {
      throw new Error('rpc down');
    });
    const { makeClient, clock, bumpWasmClientGeneration } = await importWithReader(createClient, () => rpcUrl);
    const client = makeClient();

    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    clock.now += 29_999;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    if (change === 'generation') bumpWasmClientGeneration();
    else rpcUrl = 'https://rpc-b.example';
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(3);
    // The new key's first window is 30 s; carrying the old key's count over would make it 120 s.
    clock.now += 29_999;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(3);
    clock.now += 1;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(4);
  });

  it('a build for another key retires the old backoff, so a repoint back builds at once', async () => {
    let rpcUrl = 'https://rpc-a.example';
    const createClient = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockImplementation(async () => emptyReader());
    const { makeClient } = await importWithReader(createClient, () => rpcUrl);
    const client = makeClient();

    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    rpcUrl = 'https://rpc-b.example';
    await expect(client.getConsumableNotes('mtst1account')).resolves.toEqual([]);
    rpcUrl = 'https://rpc-a.example';
    await expect(client.getConsumableNotes('mtst1account')).resolves.toEqual([]);
    expect(createClient).toHaveBeenCalledTimes(3);
  });

  it('a key that comes back after another starts from the first window, whatever its old entry counted (A -> B -> A)', async () => {
    let rpcUrl = 'https://rpc-a.example';
    const createClient = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc down')) // A: first failure
      .mockImplementationOnce(async () => emptyReader()) // A: success after the window
      .mockImplementationOnce(async () => emptyReader()) // B: success
      .mockRejectedValueOnce(new Error('rpc down')) // A again: must count as a first failure
      .mockImplementation(async () => emptyReader());
    const { makeClient, clock } = await importWithReader(createClient, () => rpcUrl);
    const client = makeClient();

    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    clock.now += 29_999;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await expect(client.getConsumableNotes('mtst1account')).resolves.toEqual([]);
    rpcUrl = 'https://rpc-b.example';
    await expect(client.getConsumableNotes('mtst1account')).resolves.toEqual([]);
    rpcUrl = 'https://rpc-a.example';
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(4);
    // First window again (30 s). The successful A entry still counts its one failure (a success resets nothing), so
    // a count carried across the keys would make this window 60 s.
    clock.now += 29_999;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(4);
    clock.now += 1;
    await expect(client.getConsumableNotes('mtst1account')).resolves.toEqual([]);
    expect(createClient).toHaveBeenCalledTimes(5);
  });

  const deferredCreateClient = () => {
    const builds: { resolve: (reader: unknown) => void; reject: (error: Error) => void }[] = [];
    const createClient = jest.fn(
      () =>
        new Promise((resolve, reject) => {
          builds.push({ resolve, reject });
        })
    );
    const build = (index: number) => {
      const handle = builds[index];
      if (!handle) throw new Error(`build #${index + 1} never started`);
      return handle;
    };
    const waitForBuilds = async (count: number) => {
      for (let i = 0; i < 50 && createClient.mock.calls.length < count; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(createClient).toHaveBeenCalledTimes(count);
    };
    return { createClient, build, waitForBuilds };
  };

  it.each([
    ['rejects', (settle: { reject: (error: Error) => void }) => settle.reject(new Error('stale build failed'))],
    ['resolves', (settle: { resolve: (reader: unknown) => void }) => settle.resolve(emptyReader())]
  ])('a stale build that %s late cannot touch the backoff of the build that replaced it', async (how, settleStale) => {
    const { createClient, build, waitForBuilds } = deferredCreateClient();
    const { makeClient, bumpWasmClientGeneration, clock, log, warn } = await importWithReader(createClient);
    const client = makeClient();

    // Read #1 must reach the reader before the bump, or both reads share one build.
    const first = client.getConsumableNotes('mtst1account').catch(() => undefined);
    await waitForBuilds(1);
    bumpWasmClientGeneration();
    const second = client.getConsumableNotes('mtst1account');
    await waitForBuilds(2);
    build(1).reject(new Error('current build failed'));
    await expect(second).rejects.toThrow('current build failed');
    // The stale build settles later, so a window it cleared, re-armed or stretched would differ from the current
    // build's own.
    clock.now += 10_000;
    settleStale(build(0));
    await first;

    // The current build's own first window (30 s from its own failure) ends exactly on time.
    clock.now += 19_999;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('current build failed');
    expect(createClient).toHaveBeenCalledTimes(2);
    clock.now += 1;
    const third = client.getConsumableNotes('mtst1account');
    await waitForBuilds(3);
    // And its count stayed its own: build three is its SECOND failure, so the next window is 60 s. A stale settle
    // that bumped the count would make it 120 s, and one that zeroed it 30 s.
    build(2).reject(new Error('third build failed'));
    await expect(third).rejects.toThrow('third build failed');
    clock.now += 59_999;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('third build failed');
    expect(createClient).toHaveBeenCalledTimes(3);
    clock.now += 1;
    void client.getConsumableNotes('mtst1account').catch(() => undefined);
    await waitForBuilds(4);
    // Only the build that governs its key names a window; the stale one, if it fails, says it no longer governs.
    const failures = readerLines(warn, 'build ');
    expect(failures.filter(line => line.includes('next build in'))).toEqual([
      expect.stringContaining('failed (1 in a row) - next build in 30s'),
      expect.stringContaining('failed (2 in a row) - next build in 60s')
    ]);
    expect(failures.filter(line => line.includes('moved on'))).toHaveLength(how === 'rejects' ? 1 : 0);
    // No build here succeeded after failing, so no line claims a streak ended.
    expect(readerLines(log, 'build ')).toEqual([]);
  });

  it('a failed build backs off from its own failure, not from the read that started it', async () => {
    const { createClient, build, waitForBuilds } = deferredCreateClient();
    const { makeClient, clock } = await importWithReader(createClient);
    const client = makeClient();

    const first = client.getConsumableNotes('mtst1account');
    await waitForBuilds(1);
    // The build parks past its whole first window (a slow genesis fetch) before it fails.
    clock.now += 45_000;
    build(0).reject(new Error('rpc down'));
    await expect(first).rejects.toThrow('rpc down');
    clock.now += 29_999;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('rpc down');
    expect(createClient).toHaveBeenCalledTimes(1);
    clock.now += 1;
    void client.getConsumableNotes('mtst1account').catch(() => undefined);
    await waitForBuilds(2);
  });

  it('a build that fails after a client replacement backs off only its own generation', async () => {
    const { createClient, build, waitForBuilds } = deferredCreateClient();
    const { makeClient, bumpWasmClientGeneration, warn } = await importWithReader(createClient);
    const client = makeClient();

    const first = client.getConsumableNotes('mtst1account');
    await waitForBuilds(1);
    // The watchdog evicts the hold mid-build: the generation moves on before the build settles, and nothing
    // looks the reader up in between, so the failed build is still the one in the slot.
    bumpWasmClientGeneration();
    build(0).reject(new Error('stale build failed'));
    await expect(first).rejects.toThrow('stale build failed');
    // Its key moved while it was pending, so it names no window: the next read builds at once.
    expect(readerLines(warn, 'build ')).toEqual([expect.stringContaining('failed after the reader moved on')]);

    const second = client.getConsumableNotes('mtst1account');
    await waitForBuilds(2);
    build(1).resolve(emptyReader());
    await expect(second).resolves.toEqual([]);
  });

  it('a build whose URL moved while it was pending backs off only its own URL', async () => {
    let rpcUrl = 'https://rpc-a.example';
    const { createClient, build, waitForBuilds } = deferredCreateClient();
    const { makeClient, warn } = await importWithReader(createClient, () => rpcUrl);
    const client = makeClient();

    const first = client.getConsumableNotes('mtst1account');
    await waitForBuilds(1);
    rpcUrl = 'https://rpc-b.example';
    build(0).reject(new Error('stale build failed'));
    await expect(first).rejects.toThrow('stale build failed');
    // Its key moved while it was pending, so it names no window: the next read builds at once.
    expect(readerLines(warn, 'build ')).toEqual([expect.stringContaining('failed after the reader moved on')]);

    const second = client.getConsumableNotes('mtst1account');
    await waitForBuilds(2);
    build(1).resolve(emptyReader());
    await expect(second).resolves.toEqual([]);
  });

  it('a build whose URL moved away and back before any read keeps its own window', async () => {
    let rpcUrl = 'https://rpc-a.example';
    const { createClient, build, waitForBuilds } = deferredCreateClient();
    const { makeClient, clock } = await importWithReader(createClient, () => rpcUrl);
    const client = makeClient();

    const first = client.getConsumableNotes('mtst1account');
    await waitForBuilds(1);
    rpcUrl = 'https://rpc-b.example';
    build(0).reject(new Error('stale build failed'));
    await expect(first).rejects.toThrow('stale build failed');
    // Back on its own URL before any read: the failed build is its key's entry again, so its own window applies. A
    // build that skipped the stamp here would serve its rejection forever.
    rpcUrl = 'https://rpc-a.example';
    clock.now += 29_999;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toThrow('stale build failed');
    expect(createClient).toHaveBeenCalledTimes(1);
    clock.now += 1;
    void client.getConsumableNotes('mtst1account').catch(() => undefined);
    await waitForBuilds(2);
  });

  it('shares one reader build between concurrent first reads', async () => {
    const createClient = jest.fn(async () => emptyReader());
    const { makeClient } = await importWithReader(createClient);
    const client = makeClient();

    await Promise.all([client.getConsumableNotes('mtst1account'), client.getConsumableNotes('mtst1account')]);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('a stale build failure leaves a healthy replacement reader in place, with no window and no rebuild', async () => {
    const { createClient, build, waitForBuilds } = deferredCreateClient();
    const { makeClient, bumpWasmClientGeneration, clock, warn } = await importWithReader(createClient);
    const client = makeClient();

    // Wait for read #1 to reach the reader (past its own awaits) before the bump, or
    // both reads would share one new-generation build and prove nothing.
    const first = client.getConsumableNotes('mtst1account');
    await waitForBuilds(1);
    bumpWasmClientGeneration();
    const second = client.getConsumableNotes('mtst1account');
    await waitForBuilds(2);
    build(1).resolve(emptyReader());
    await expect(second).resolves.toEqual([]);
    build(0).reject(new Error('stale build failed'));
    await expect(first).rejects.toThrow('stale build failed');

    await expect(client.getConsumableNotes('mtst1account')).resolves.toEqual([]);
    expect(createClient).toHaveBeenCalledTimes(2);
    // A built reader is never rebuilt for its own key. Had the stale failure stamped it, it would carry a 30 s
    // window and be rebuilt (the old one stranded) once that passed. waitForBuilds exits early once the count is
    // reached, so flush explicitly before checking that no third build started.
    clock.now += 30_000;
    const later = client.getConsumableNotes('mtst1account');
    for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(createClient).toHaveBeenCalledTimes(2);
    await expect(later).resolves.toEqual([]);
    expect(readerLines(warn, 'build ')).toEqual([expect.stringContaining('failed after the reader moved on')]);
  });

  // Last on purpose: it proves the reader block above left no module mock registered behind it.
  it('leaves no reader-block module mock behind for the tests that follow', async () => {
    // Each check tells a reader-block double from the base module this spec otherwise gets.
    const lazy = await import('@miden-sdk/miden-sdk/lazy');
    expect('WasmWebClient' in lazy).toBe(false); // the base is __mocks__/wasmMock.js
    const endpoints = await import('lib/miden-chain/effective-endpoints');
    expect('loadEndpointOverrides' in endpoints).toBe(true);
    const connectivity = await import('lib/miden/activity/connectivity-state');
    expect('getConnectivityState' in connectivity).toBe(true);
    const helpers = await import('./helpers');
    let bech32: unknown;
    try {
      bech32 = Reflect.apply(helpers.getBech32AddressFromAccountId, undefined, ['x']);
    } catch {
      bech32 = undefined;
    }
    expect(bech32).not.toBe('bech32(x)');
    // And no spy the block installs outlives its test (console.log is spied file-wide, so it is not one of them).
    expect(jest.isMockFunction(performance.now)).toBe(false);
    expect(jest.isMockFunction(Math.random)).toBe(false);
    expect(jest.isMockFunction(console.warn)).toBe(false);
  });
});
