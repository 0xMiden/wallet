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

    jest.doMock('@miden-sdk/miden-sdk', () => ({
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
    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const bridge = await import('./keystore-bridge');
    const client = await MidenClientInterface.create();

    // Permanent keystore wiring: callbacks come from the bridge module,
    // not from per-call options. Assert the bridge functions are wired.
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcUrl: 'rpc-local',
        keystore: expect.objectContaining({
          insertKey: bridge.callInsertKey,
          sign: bridge.callSign,
          getKey: bridge.callGetKey
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
    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
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

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      AccountFile: { deserialize: jest.fn(() => ({})) }
    }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));
    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.importMidenWallet(new Uint8Array([1, 2, 3]));
    expect(result).toBe('id');
    expect(fakeMidenClient.accounts.import).toHaveBeenCalled();
  });

  it('sends private note', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
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

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      TransactionProver: {
        newLocalProver: jest.fn(() => 'local')
      }
    }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));
    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.newTransaction('acc-id', new Uint8Array([1, 2]));
    expect(result).toBe(fakeTransactionResult);
    expect(fakeMidenClient.transactions.submit).toHaveBeenCalled();
  });

  it('waits for transaction commit successfully', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
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

    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
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
    jest.doMock('@miden-sdk/miden-sdk', () => ({
      TransactionProver: {
        newLocalProver: jest.fn(() => 'local')
      }
    }));
    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
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

  it('waitForIdle calls client method when available', async () => {
    const waitForIdleMock = jest.fn(async () => {});
    const fakeMidenClient = buildFakeMidenClient({ waitForIdle: waitForIdleMock });

    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await client.waitForIdle();
    expect(waitForIdleMock).toHaveBeenCalled();
  });

  it('waitForIdle is a no-op when client lacks the method', async () => {
    const fakeMidenClient = buildFakeMidenClient();
    // Ensure waitForIdle is absent
    delete (fakeMidenClient as any).waitForIdle;

    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    // Should not throw
    await client.waitForIdle();
    expect(true).toBe(true);
  });

  it('getInputNote returns a note by id', async () => {
    const fakeNote = { id: () => 'note-1' };
    const fakeMidenClient = buildFakeMidenClient({
      notes: { get: jest.fn(async () => fakeNote) }
    });

    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.getInputNote('note-1');
    expect(result).toBe(fakeNote);
    expect(fakeMidenClient.notes.get).toHaveBeenCalledWith('note-1');
  });

  it('delegates proving and falls back to local prover on error', async () => {
    let callCount = 0;
    const fakeMidenClient = buildFakeMidenClient({
      transactions: {
        send: jest.fn(async () => {
          callCount++;
          if (callCount === 1) throw new Error('remote prover failed');
          return { txId: 'tx-id', result: fakeTransactionResult };
        })
      }
    });

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      TransactionProver: {
        newLocalProver: jest.fn(() => 'local'),
        newRemoteProver: jest.fn(() => 'remote')
      }
    }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));
    const connectivityMock = { addConnectivityIssue: jest.fn() };
    jest.doMock('lib/miden/activity/connectivity-issues', () => connectivityMock);

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const result = await client.sendTransaction({
      accountId: 'sender',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      noteType: 'public' as any,
      amount: BigInt(100),
      extraInputs: {},
      delegateTransaction: true
    } as any);

    expect(result).toBe(fakeTransactionResult);
    expect(connectivityMock.addConnectivityIssue).toHaveBeenCalled();
    expect(fakeMidenClient.transactions.send).toHaveBeenCalledTimes(2);
  });

  it('creates mock client when MIDEN_USE_MOCK_CLIENT is set', async () => {
    const originalEnv = process.env.MIDEN_USE_MOCK_CLIENT;
    process.env.MIDEN_USE_MOCK_CLIENT = 'true';

    const fakeMockClient = buildFakeMidenClient();
    jest.doMock('@miden-sdk/miden-sdk', () => ({
      MidenClient: {
        create: jest.fn(),
        createMock: jest.fn(async () => fakeMockClient)
      }
    }));
    jest.doMock('lib/miden-chain/constants', () => ({
      MIDEN_NETWORK_ENDPOINTS: new Map([['testnet', 'rpc']]),
      MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS: new Map(),
      MIDEN_PROVING_ENDPOINTS: new Map(),
      DEFAULT_NETWORK: 'testnet'
    }));
    jest.doMock('./keystore-bridge', () => ({
      callGetKey: jest.fn(),
      callInsertKey: jest.fn(),
      callSign: jest.fn()
    }));
    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
    }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = await MidenClientInterface.create();

    expect(client.network).toBe('mock');
    expect(client.client).toBe(fakeMockClient);

    process.env.MIDEN_USE_MOCK_CLIENT = originalEnv;
  });

  it('consumeNoteId returns TransactionResult', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      TransactionProver: {
        newLocalProver: jest.fn(() => 'local')
      }
    }));
    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
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
});
