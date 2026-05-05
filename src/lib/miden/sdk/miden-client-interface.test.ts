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
        sendPrivate: jest.fn(async () => undefined),
        ...overrides.notes
      },
      transactions: {
        send: jest.fn(async () => ({ txId: 'tx-id', result: fakeTransactionResult })),
        consume: jest.fn(async () => ({ txId: 'tx-id', result: fakeTransactionResult })),
        submit: jest.fn(async () => ({ txId: 'tx-id', result: fakeTransactionResult })),
        list: jest.fn(async () => [
          { accountId: () => 'id', serialize: () => new Uint8Array([9]) },
          { accountId: () => 'other', serialize: () => new Uint8Array([9]) }
        ]),
        waitFor: jest.fn(async () => {}),
        ...overrides.transactions
      },
      sync: jest.fn(async () => ({ blockNum: () => 5 })),
      storeIdentifier: jest.fn(() => 'test-store'),
      terminate: jest.fn(),
      defaultProver: null,
      ...overrides
    };
  }

  it('creates a client with provided callbacks', async () => {
    const fakeMidenClient = buildFakeMidenClient();
    const createMock = jest.fn(async () => fakeMidenClient);

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      MidenClient: { create: createMock, createMock: jest.fn() },
      NoteFile: { deserialize: jest.fn(() => ({})) },
      AccountFile: { deserialize: jest.fn(() => ({})) },
      NoteExportFormat: { Id: 'Id', Full: 'Full', Details: 'Details' },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      TransactionProver: {
        newRemoteProver: jest.fn(() => 'remote'),
        newLocalProver: jest.fn(() => 'local')
      },
      exportStore: jest.fn(async () => '{"version":1,"data":"dump"}'),
      importStore: jest.fn()
    }));
    jest.doMock('lib/miden-chain/constants', () => ({
      MIDEN_NETWORK_ENDPOINTS: new Map([
        ['testnet', 'rpc'],
        ['devnet', 'rpc-dev'],
        ['localnet', 'rpc-local']
      ]),
      MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS: new Map([
        ['testnet', undefined],
        ['localnet', undefined]
      ]),
      getNoteTransportUrl: (_network: string) => undefined,
      MIDEN_PROVING_ENDPOINTS: new Map([
        ['testnet', 'prover'],
        ['localnet', undefined]
      ]),
      MIDEN_NETWORK_NAME: { TESTNET: 'testnet', DEVNET: 'devnet', LOCALNET: 'localnet' },
      DEFAULT_NETWORK: 'localnet'
    }));
    jest.doMock('./constants', () => ({ NoteExportType: {} }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));
    jest.doMock('../helpers', () => ({ toNoteType: jest.fn() }));
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

    client.free();
    expect(client.client.terminate).toBeDefined();

    // smoke a few methods
    await client.createMidenWallet('on-chain' as any, new Uint8Array([4]));
    await client.importPublicMidenWalletFromSeed(new Uint8Array([5]));
    await client.importNoteBytes(new Uint8Array([1, 2]));
    await client.getInputNoteDetails();
    await client.getConsumableNotes('id');
    await client.exportNote('note', {} as any);
    await client.getTransactionsForAccount('id');
    await client.exportDb();
    await client.importDb('{"version":1,"data":"dump"}');
    await client.sendTransaction({
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
    } as any);
    await client.consumeNoteId({
      accountId: 'id',
      noteId: 'note',
      faucetId: 'f',
      type: 'consume'
    } as any);
    await client.newTransaction('acc-id', new Uint8Array([1, 2]));
  });

  it('creates client from existing MidenClient using fromClient', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id)
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

  it('imports wallet from bytes', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      AccountFile: { deserialize: jest.fn(() => ({})) }
    }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id)
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

    expect(fakeMidenClient.notes.sendPrivate).toHaveBeenCalledWith({
      note: mockNote,
      to: 'recipient-bech32'
    });
  });

  it('executes new transaction and returns TransactionResult', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      TransactionProver: {
        newLocalProver: jest.fn(() => 'local')
      }
    }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.newTransaction('acc-id', new Uint8Array([1, 2]));
    expect(result).toBe(fakeTransactionResult);
    expect(fakeMidenClient.transactions.submit).toHaveBeenCalled();
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
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      TransactionProver: {
        newLocalProver: jest.fn(() => 'local')
      }
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.sendTransaction({
      accountId: 'sender',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      noteType: 'public' as any,
      amount: BigInt(100),
      extraInputs: {}
    } as any);

    expect(result).toBe(fakeTransactionResult);
    expect(fakeMidenClient.transactions.send).toHaveBeenCalled();
  });

  it('consumeNoteId returns TransactionResult', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      TransactionProver: {
        newLocalProver: jest.fn(() => 'local')
      }
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.consumeNoteId({
      accountId: 'acc-id',
      noteId: 'note-1',
      type: 'consume'
    } as any);

    expect(result).toBe(fakeTransactionResult);
    expect(fakeMidenClient.transactions.consume).toHaveBeenCalled();
  });

  describe('withProverFallback connectivity-state categorization', () => {
    // Build a client that fails the first (delegate) call with a provided error and
    // succeeds the second (local-prover) call. Returns the connectivity-state spies
    // so the caller can assert whether prover was marked / cleared.
    async function runDelegateFailureCase(err: Error) {
      const markConnectivityIssue = jest.fn();
      const clearConnectivityIssue = jest.fn();
      const consume = jest
        .fn()
        .mockImplementationOnce(async () => {
          throw err;
        })
        .mockImplementationOnce(async () => ({ txId: 'tx-id', result: fakeTransactionResult }));

      const fakeMidenClient = buildFakeMidenClient({ transactions: { consume } });

      jest.doMock('@miden-sdk/miden-sdk', () => ({
        TransactionProver: { newLocalProver: jest.fn(() => 'local') }
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue,
        clearConnectivityIssue
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const result = await client.consumeNoteId({
        accountId: 'acc-id',
        noteId: 'note-1',
        type: 'consume',
        delegateTransaction: true
      } as any);

      expect(result).toBe(fakeTransactionResult);
      expect(consume).toHaveBeenCalledTimes(2); // delegate attempt + local retry
      return { markConnectivityIssue, clearConnectivityIssue };
    }

    it('does NOT mark prover for "note has already been consumed"', async () => {
      const { markConnectivityIssue } = await runDelegateFailureCase(
        new Error('failed to execute transaction: invalid transaction request: note 0xdead has already been consumed')
      );
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
      const consume = jest.fn(async () => ({ txId: 'tx-id', result: fakeTransactionResult }));
      const fakeMidenClient = buildFakeMidenClient({ transactions: { consume } });

      jest.doMock('@miden-sdk/miden-sdk', () => ({
        TransactionProver: { newLocalProver: jest.fn(() => 'local') }
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue,
        clearConnectivityIssue
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await client.consumeNoteId({
        accountId: 'acc-id',
        noteId: 'note-1',
        type: 'consume',
        delegateTransaction: true
      } as any);

      expect(markConnectivityIssue).not.toHaveBeenCalled();
      expect(clearConnectivityIssue).toHaveBeenCalledWith('prover');
    });
  });

  // Offscreen-prove + speculation paths.
  //
  // Each test runs with `MIDEN_USE_OFFSCREEN_PROVING=true` (set before the
  // module is imported, via `process.env`) so `shouldUseOffscreenProver`
  // returns true. We mock `isOffscreenAvailable` to true and stub the
  // proveViaOffscreen + speculation manager + WASM lock surfaces.
  //
  // The mock client carries `_getInnerWebClient` returning a stub `inner`
  // that captures executeTransaction / submitProvenTransaction /
  // applyTransaction calls so we can assert the right pipeline pieces ran.
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

    function buildOffscreenStubs(
      opts: {
        cacheHit?: { txResultBytes: Uint8Array; provenBytes: Uint8Array; paramsHash: string } | null;
        hasInFlightMatching?: boolean;
        awaitMatching?: () => Promise<void>;
        proveViaOffscreen?: jest.Mock;
      } = {}
    ) {
      const consumeCacheHit = jest.fn(() => opts.cacheHit ?? null);
      const hasInFlightMatching = jest.fn(() => opts.hasInFlightMatching ?? false);
      const awaitMatching = jest.fn(opts.awaitMatching ?? (async () => {}));
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
      jest.doMock('lib/miden/back/speculation-manager', () => ({
        getSpeculationManager: () => ({
          consumeCacheHit,
          hasInFlightMatching,
          awaitMatching
        })
      }));
      jest.doMock('./miden-client', () => ({
        yieldWasmClientLock: async <T>(op: () => Promise<T>) => op()
      }));

      return { consumeCacheHit, hasInFlightMatching, awaitMatching, proveViaOffscreen };
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

    function buildClientWithInner(inner: any, fakeWasm: any, network = 'testnet') {
      const fakeMidenClient = buildFakeMidenClient();
      // The proveLocallyViaOffscreen path reads the inner WebClient via
      // `_getInnerWebClient` — attach a tracker so the test can assert
      // submitProvenTransaction + applyTransaction were called in order.
      (fakeMidenClient as any)._getInnerWebClient = () => inner;
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) }
      }));
      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id)
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));
      return fakeMidenClient;
    }

    it('cache hit: skips execute+prove, runs only submit+apply', async () => {
      const fakeWasm = buildWasmStub();
      const inner = {
        executeTransaction: jest.fn(),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => undefined),
        newSendTransactionRequest: jest.fn(async () => ({}))
      };
      const cacheHit = {
        txResultBytes: new Uint8Array([1, 2, 3]),
        provenBytes: new Uint8Array([4, 5, 6]),
        paramsHash: 'sender|recip|faucet|public|100'
      };
      const stubs = buildOffscreenStubs({ cacheHit });

      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      // Make sure getWasmOrThrow returns our fake wasm.
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const result = await client.sendTransaction({
        accountId: 'sender',
        secondaryAccountId: 'recip',
        faucetId: 'faucet',
        noteType: 'public' as any,
        amount: BigInt(100),
        extraInputs: {}
      } as any);

      expect(result).toBe(fakeTransactionResult);
      // Cache hit was consumed, NO execute, just submit + apply.
      expect(stubs.consumeCacheHit).toHaveBeenCalledTimes(1);
      expect(inner.executeTransaction).not.toHaveBeenCalled();
      expect(stubs.proveViaOffscreen).not.toHaveBeenCalled();
      expect(inner.submitProvenTransaction).toHaveBeenCalled();
      expect(inner.applyTransaction).toHaveBeenCalled();
    });

    it('cache miss + in-flight matching: awaits, then re-checks cache', async () => {
      const fakeWasm = buildWasmStub();
      const inner = {
        executeTransaction: jest.fn(async () => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => undefined),
        newSendTransactionRequest: jest.fn(async () => ({}))
      };
      // The first consumeCacheHit returns null (initial miss). After
      // awaitMatching resolves, the second consumeCacheHit returns the hit
      // (the speculation we awaited just completed and populated the cache).
      const consumeCacheHit = jest
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({
          txResultBytes: new Uint8Array([1]),
          provenBytes: new Uint8Array([2]),
          paramsHash: 'sender|recip|faucet|public|100'
        });
      const hasInFlightMatching = jest.fn(() => true);
      const awaitMatching = jest.fn(async () => {});
      jest.doMock('lib/miden/back/offscreen-prover', () => ({
        isOffscreenAvailable: () => true,
        proveViaOffscreen: jest.fn()
      }));
      jest.doMock('lib/miden/back/speculation-manager', () => ({
        getSpeculationManager: () => ({ consumeCacheHit, hasInFlightMatching, awaitMatching })
      }));
      jest.doMock('./miden-client', () => ({
        yieldWasmClientLock: async <T>(op: () => Promise<T>) => op()
      }));
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await client.sendTransaction({
        accountId: 'sender',
        secondaryAccountId: 'recip',
        faucetId: 'faucet',
        noteType: 'public' as any,
        amount: BigInt(100),
        extraInputs: {}
      } as any);

      expect(awaitMatching).toHaveBeenCalledTimes(1);
      expect(consumeCacheHit).toHaveBeenCalledTimes(2);
      // Hit on the re-check → execute is still skipped.
      expect(inner.executeTransaction).not.toHaveBeenCalled();
      expect(inner.submitProvenTransaction).toHaveBeenCalled();
    });

    it('cache miss without in-flight matching: runs fresh execute + prove + submit + apply', async () => {
      const fakeWasm = buildWasmStub();
      const inner = {
        executeTransaction: jest.fn(async () => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => undefined),
        newSendTransactionRequest: jest.fn(async () => ({}))
      };
      const stubs = buildOffscreenStubs({ cacheHit: null, hasInFlightMatching: false });
      const fakeMidenClient = buildClientWithInner(inner, fakeWasm);
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await client.sendTransaction({
        accountId: 'sender',
        secondaryAccountId: 'recip',
        faucetId: 'faucet',
        noteType: 'public' as any,
        amount: BigInt(100),
        extraInputs: {}
      } as any);

      // No cache hit and no in-flight match → awaitMatching skipped, fresh
      // execute + prove + submit + apply.
      expect(stubs.consumeCacheHit).toHaveBeenCalledTimes(1);
      expect(stubs.awaitMatching).not.toHaveBeenCalled();
      expect(inner.executeTransaction).toHaveBeenCalledTimes(1);
      expect(stubs.proveViaOffscreen).toHaveBeenCalledTimes(1);
      expect(inner.submitProvenTransaction).toHaveBeenCalledTimes(1);
      expect(inner.applyTransaction).toHaveBeenCalledTimes(1);
    });

    it('cache miss with reclaimAfter set: skips speculation cache (no cacheParams)', async () => {
      const fakeWasm = buildWasmStub();
      const inner = {
        executeTransaction: jest.fn(async () => fakeTransactionResult),
        submitProvenTransaction: jest.fn(async () => 100),
        applyTransaction: jest.fn(async () => undefined),
        newSendTransactionRequest: jest.fn(async () => ({}))
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

      await client.sendTransaction({
        accountId: 'sender',
        secondaryAccountId: 'recip',
        faucetId: 'faucet',
        noteType: 'public' as any,
        amount: BigInt(100),
        extraInputs: { recallBlocks: 5 }
      } as any);

      // recallBlocks set → cacheParams is undefined → no cache check at all.
      expect(stubs.consumeCacheHit).not.toHaveBeenCalled();
      expect(stubs.hasInFlightMatching).not.toHaveBeenCalled();
      expect(inner.executeTransaction).toHaveBeenCalledTimes(1);
    });

    it('consumeNoteId offscreen path: builds request from inner.getInputNote → toNote → array', async () => {
      const fakeWasm = buildWasmStub();
      const note = { kind: 'note' };
      const inputNoteRecord = { toNote: jest.fn(() => note) };
      const inner = {
        getInputNote: jest.fn(async () => inputNoteRecord),
        newConsumeTransactionRequest: jest.fn(async () => ({ kind: 'request' })),
        executeTransaction: jest.fn(async () => fakeTransactionResult),
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

      await client.consumeNoteId({
        accountId: 'mtst1acc',
        noteId: 'note-id-123',
        type: 'consume'
      } as any);

      expect(inner.getInputNote).toHaveBeenCalledWith('note-id-123');
      expect(inputNoteRecord.toNote).toHaveBeenCalledTimes(1);
      // Plain JS array, NOT wasm.NoteArray.
      expect(inner.newConsumeTransactionRequest).toHaveBeenCalledWith([note]);
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
        client.consumeNoteId({
          accountId: 'mtst1acc',
          noteId: 'missing-note',
          type: 'consume'
        } as any)
      ).rejects.toThrow(/Note missing-note not found in store/);
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

      // Two deserialize calls: one at the top of the method (used as the
      // fallback path's request) and one inside proveLocallyViaOffscreen's
      // builder closure (a fresh deserialization, since wasm-bindgen
      // executeTransaction consumes the value).
      expect(txRequestDeserialize).toHaveBeenCalledTimes(2);
      expect(stubs.proveViaOffscreen).toHaveBeenCalledTimes(1);
      expect(inner.submitProvenTransaction).toHaveBeenCalledTimes(1);
    });

    it('throws and logs when proveLocallyViaOffscreen pipeline fails', async () => {
      const fakeWasm = buildWasmStub();
      const inner = {
        executeTransaction: jest.fn(async () => {
          throw new Error('execute failed');
        }),
        submitProvenTransaction: jest.fn(),
        applyTransaction: jest.fn(),
        newSendTransactionRequest: jest.fn(async () => ({}))
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
        client.sendTransaction({
          accountId: 'sender',
          secondaryAccountId: 'recip',
          faucetId: 'faucet',
          noteType: 'public' as any,
          amount: BigInt(100),
          extraInputs: {}
        } as any)
      ).rejects.toThrow(/execute failed/);
    });
  });

  describe('executeAndProveForSpeculation', () => {
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

    it('throws when isOffscreenAvailable is false', async () => {
      jest.doMock('lib/miden/back/offscreen-prover', () => ({
        isOffscreenAvailable: () => false,
        proveViaOffscreen: jest.fn()
      }));
      jest.doMock('lib/miden/back/speculation-manager', () => ({
        getSpeculationManager: () => null
      }));
      jest.doMock('./miden-client', () => ({
        yieldWasmClientLock: async <T>(op: () => Promise<T>) => op()
      }));
      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id)
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));

      const fakeMidenClient = buildFakeMidenClient();
      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await expect(
        client.executeAndProveForSpeculation({
          accountId: 'sender',
          recipientAccountId: 'recip',
          faucetId: 'faucet',
          noteType: 'public',
          amount: 100n
        })
      ).rejects.toThrow(/without chrome.offscreen available/);
    });

    it('throws when _getInnerWebClient is missing on the client', async () => {
      const fakeWasm = {
        TransactionResult: { deserialize: jest.fn() },
        ProvenTransaction: { deserialize: jest.fn() },
        AccountId: { fromBech32: jest.fn(), fromHex: jest.fn() },
        NoteType: { Public: 'Public', Private: 'Private' }
      };
      jest.doMock('lib/miden/back/offscreen-prover', () => ({
        isOffscreenAvailable: () => true,
        proveViaOffscreen: jest.fn()
      }));
      jest.doMock('lib/miden/back/speculation-manager', () => ({
        getSpeculationManager: () => null
      }));
      jest.doMock('./miden-client', () => ({
        yieldWasmClientLock: async <T>(op: () => Promise<T>) => op()
      }));
      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id)
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const fakeMidenClient = buildFakeMidenClient();
      // No _getInnerWebClient attached.
      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await expect(
        client.executeAndProveForSpeculation({
          accountId: 'sender',
          recipientAccountId: 'recip',
          faucetId: 'faucet',
          noteType: 'public',
          amount: 100n
        })
      ).rejects.toThrow(/_getInnerWebClient missing/);
    });

    it('returns serialized cache entry on success', async () => {
      const fakeWasm = {
        TransactionResult: { deserialize: jest.fn() },
        ProvenTransaction: { deserialize: jest.fn() },
        AccountId: {
          fromBech32: jest.fn((id: string) => ({ tag: 'b32', id })),
          fromHex: jest.fn((id: string) => ({ tag: 'hex', id }))
        },
        NoteType: { Public: 'Public', Private: 'Private' }
      };
      const txResult = {
        serialize: () => new Uint8Array([0xa, 0xb])
      };
      const inner = {
        executeTransaction: jest.fn(async () => txResult),
        newSendTransactionRequest: jest.fn(async () => ({ kind: 'request' }))
      };
      const proveViaOffscreen = jest.fn(async () => ({
        provenBytes: new Uint8Array([0xc, 0xd]).buffer,
        durationMs: 5
      }));
      jest.doMock('lib/miden/back/offscreen-prover', () => ({
        isOffscreenAvailable: () => true,
        proveViaOffscreen
      }));
      jest.doMock('lib/miden/back/speculation-manager', () => ({
        getSpeculationManager: () => null
      }));
      jest.doMock('./miden-client', () => ({
        yieldWasmClientLock: async <T>(op: () => Promise<T>) => op()
      }));
      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id)
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        ...fakeWasm,
        TransactionProver: { newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) },
        TransactionRequest: { deserialize: jest.fn(() => ({})) },
        getWasmOrThrow: async () => fakeWasm
      }));

      const fakeMidenClient = buildFakeMidenClient();
      (fakeMidenClient as any)._getInnerWebClient = () => inner;
      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const entry = await client.executeAndProveForSpeculation({
        accountId: 'mtst1sender',
        recipientAccountId: '0xrecipient',
        faucetId: 'mtst1faucet',
        noteType: 'private',
        amount: 250n
      });

      expect(entry.paramsHash).toBe('mtst1sender|0xrecipient|mtst1faucet|private|250');
      expect(entry.txResultBytes).toEqual(new Uint8Array([0xa, 0xb]));
      expect(new Uint8Array(entry.provenBytes)).toEqual(new Uint8Array([0xc, 0xd]));

      // Account ID resolution: accounts beginning with 0x → fromHex,
      // otherwise → fromBech32.
      expect(fakeWasm.AccountId.fromBech32).toHaveBeenCalledWith('mtst1sender');
      expect(fakeWasm.AccountId.fromHex).toHaveBeenCalledWith('0xrecipient');
      expect(proveViaOffscreen).toHaveBeenCalledWith(expect.any(Uint8Array), null, { speculative: true });
    });
  });
});
