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

  it('creates a client with provided callbacks', async () => {
    const fakeWebClient = {
      free: jest.fn(),
      newWallet: jest.fn(async () => ({ id: () => 'id' })),
      importPublicAccountFromSeed: jest.fn(async () => ({ id: () => 'id' })),
      newConsumeTransactionRequest: jest.fn(() => ({})),
      executeTransaction: jest.fn(async () => ({
        serialize: () => new Uint8Array([2])
      })),
      importNoteFile: jest.fn(async () => 'note'),
      getAccount: jest.fn(async () => 'acc'),
      importAccountById: jest.fn(async () => 'acc'),
      getAccounts: jest.fn(async () => ['acc']),
      getInputNote: jest.fn(async () => ({ toNote: () => ({}) })),
      getInputNotes: jest.fn(async () => [
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
      syncState: jest.fn(async () => ({ blockNum: () => 5 })),
      exportNoteFile: jest.fn(() => ({ serialize: () => new Uint8Array([1]) })),
      getConsumableNotes: jest.fn(() => [
        {
          noteConsumability: () => [{ accountId: () => 'id', consumableAfterBlock: () => 1 }]
        }
      ]),
      getSpentNotes: jest.fn(() => []),
      proveTransaction: jest.fn(() => ({ serialize: () => new Uint8Array([1]) })),
      submitProvenTransaction: jest.fn(async () => 10),
      applyTransaction: jest.fn(),
      submitNewTransaction: jest.fn(async () => {}),
      exportStore: jest.fn(async () => 'dump'),
      forceImportStore: jest.fn(),
      newSendTransactionRequest: jest.fn(() => ({})),
      importAccountFile: jest.fn(async () => ({ id: () => 'id' })),
      exportNoteBytes: jest.fn(() => new Uint8Array([3])),
      getTransactions: jest.fn(() => [
        { accountId: () => 'id', serialize: () => new Uint8Array([9]) },
        { accountId: () => 'other', serialize: () => new Uint8Array([9]) }
      ]),
      terminate: jest.fn()
    };

    const createClientWithExternalKeystore = jest.fn(async () => fakeWebClient);

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      WebClient: { createClientWithExternalKeystore },
      AccountStorageMode: { public: jest.fn(() => 'public'), private: jest.fn(() => 'private') },
      NoteFile: { deserialize: jest.fn(() => ({})) },
      AccountFile: { deserialize: jest.fn(() => ({})) },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      TransactionResult: { deserialize: jest.fn(() => ({ serialize: () => new Uint8Array([7]) })) },
      TransactionProver: {
        newRemoteProver: jest.fn(() => 'remote'),
        newLocalProver: jest.fn(() => 'local')
      },
      TransactionFilter: { all: jest.fn(() => 'all') },
      MIDEN_NETWORK_NAME: { TESTNET: 'testnet' }
    }));
    jest.doMock('lib/miden-chain/constants', () => ({
      MIDEN_NETWORK_ENDPOINTS: new Map([
        ['testnet', 'rpc'],
        ['devnet', 'rpc-dev']
      ]),
      MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS: new Map([['testnet', undefined]]),
      MIDEN_PROVING_ENDPOINTS: new Map([['testnet', 'prover']]),
      MIDEN_NETWORK_NAME: { TESTNET: 'testnet', DEVNET: 'devnet' },
      MIDEN_TRANSPORT_LAYER_NAME: { TESTNET: 'testnet' }
    }));
    jest.doMock('./constants', () => ({ NoteExportType: {} }));
    jest.doMock('./helpers', () => ({
      accountIdStringToSdk: (id: string) => id,
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

    const { MidenClientInterface } = await import('./miden-client-interface');
    const insertKeyCallback = jest.fn();
    const client = await MidenClientInterface.create({
      seed: new Uint8Array([1, 2, 3]),
      insertKeyCallback
    });

    expect(createClientWithExternalKeystore).toHaveBeenCalledWith(
      'rpc',
      undefined,
      expect.any(Uint8Array),
      undefined,
      undefined,
      insertKeyCallback,
      undefined
    );

    client.free();
    expect(client.webClient.terminate).toBeDefined();
    // smoke a few methods to raise coverage
    await client.createMidenWallet('on-chain' as any, new Uint8Array([4]));
    await client.importPublicMidenWalletFromSeed(new Uint8Array([5]));
    await client.importNoteBytes(new Uint8Array([1, 2]));
    await client.consumeNoteId({ accountId: 'id', noteId: 'note', faucetId: 'f', type: 'public' } as any);
    await client.getInputNoteDetails({} as any);
    await client.getConsumableNotes('id');
    await client.exportNote('note', {} as any);
    await client.getTransactionsForAccount('id');
    await client.exportDb();
    await client.importDb('dump');
    await client.submitTransaction(new Uint8Array([1, 2]), true);
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
  });

  it('creates client from existing WebClient using fromWebClient', async () => {
    const fakeWebClient = {
      free: jest.fn(),
      getAccount: jest.fn(async () => 'account'),
      getAccounts: jest.fn(async () => ['acc1', 'acc2']),
      getInputNotes: jest.fn(async () => []),
      syncState: jest.fn(async () => ({ blockNum: () => 10 })),
      importAccountById: jest.fn(async () => 'imported-acc')
    };

    jest.doMock('./helpers', () => ({
      accountIdStringToSdk: (id: string) => id,
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromWebClient(fakeWebClient as any, 'testnet');

    expect(client.network).toBe('testnet');
    expect(client.webClient).toBe(fakeWebClient);

    // Test passthrough methods
    await client.getAccount('acc-id');
    expect(fakeWebClient.getAccount).toHaveBeenCalled();

    await client.getAccounts();
    expect(fakeWebClient.getAccounts).toHaveBeenCalled();

    await client.getInputNotes({} as any);
    expect(fakeWebClient.getInputNotes).toHaveBeenCalled();

    await client.syncState();
    expect(fakeWebClient.syncState).toHaveBeenCalled();

    await client.importAccountById('acc-123');
    expect(fakeWebClient.importAccountById).toHaveBeenCalled();
  });

  it('imports wallet from bytes', async () => {
    const fakeWebClient = {
      importAccountFile: jest.fn(async () => ({ id: () => 'imported-id' }))
    };

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      AccountFile: { deserialize: jest.fn(() => ({})) }
    }));
    jest.doMock('./helpers', () => ({
      accountIdStringToSdk: (id: string) => id,
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromWebClient(fakeWebClient as any, 'testnet');

    const result = await client.importMidenWallet(new Uint8Array([1, 2, 3]));
    expect(result).toBe('imported-id');
    expect(fakeWebClient.importAccountFile).toHaveBeenCalled();
  });

  it('sends private note', async () => {
    const fakeWebClient = {
      sendPrivateNote: jest.fn(async () => undefined)
    };

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromWebClient(fakeWebClient as any, 'testnet');

    const mockNote = {} as any;
    const mockAddress = {} as any;
    await client.sendPrivateNote(mockNote, mockAddress);

    expect(fakeWebClient.sendPrivateNote).toHaveBeenCalledWith(mockNote, mockAddress);
  });

  it('executes new transaction', async () => {
    const fakeWebClient = {
      executeTransaction: jest.fn(async () => ({
        serialize: () => new Uint8Array([4, 5, 6])
      }))
    };

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      TransactionRequest: { deserialize: jest.fn(() => ({})) }
    }));
    jest.doMock('./helpers', () => ({
      accountIdStringToSdk: (id: string) => id,
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromWebClient(fakeWebClient as any, 'testnet');

    const result = await client.newTransaction('acc-id', new Uint8Array([1, 2]));
    expect(result).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('waits for transaction commit successfully', async () => {
    let syncCallCount = 0;
    const fakeWebClient = {
      syncState: jest.fn(async () => {
        syncCallCount++;
        return {};
      }),
      getTransactions: jest.fn(async () => {
        // First call: transaction still pending, second call: committed
        if (syncCallCount < 2) {
          return [{ id: () => ({ toHex: () => 'tx-123' }) }];
        }
        return [];
      })
    };

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      TransactionFilter: { uncommitted: jest.fn(() => 'uncommitted') }
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromWebClient(fakeWebClient as any, 'testnet');

    await client.waitForTransactionCommit('tx-123', 5000, 10);
    expect(fakeWebClient.syncState).toHaveBeenCalled();
  });

  it('throws timeout when transaction does not commit', async () => {
    const fakeWebClient = {
      syncState: jest.fn(async () => ({})),
      getTransactions: jest.fn(async () => [{ id: () => ({ toHex: () => 'tx-456' }) }])
    };

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      TransactionFilter: { uncommitted: jest.fn(() => 'uncommitted') }
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromWebClient(fakeWebClient as any, 'testnet');

    await expect(client.waitForTransactionCommit('tx-456', 50, 10)).rejects.toThrow(
      'Timeout waiting for transaction commit'
    );
  });

  it('calls consumeTransaction method', async () => {
    const note1 = { id: 'note-1' };
    const note2 = { id: 'note-2' };
    const notesById: Record<string, any> = {
      'note-1': note1,
      'note-2': note2
    };
    const fakeWebClient = {
      getInputNote: jest.fn(async (noteId: string) => ({
        toNote: () => notesById[noteId]
      })),
      newConsumeTransactionRequest: jest.fn(() => ({})),
      executeTransaction: jest.fn(async () => ({ serialize: () => new Uint8Array([1]) })),
      syncState: jest.fn(async () => ({})),
      proveTransaction: jest.fn(async () => ({})),
      submitProvenTransaction: jest.fn(async () => 10),
      applyTransaction: jest.fn()
    };

    jest.doMock('@miden-sdk/miden-sdk', () => ({
      TransactionProver: {
        newRemoteProver: jest.fn(() => 'remote'),
        newLocalProver: jest.fn(() => 'local')
      }
    }));
    jest.doMock('lib/miden-chain/constants', () => ({
      MIDEN_PROVING_ENDPOINTS: new Map([['testnet', 'prover-url']])
    }));
    jest.doMock('./helpers', () => ({
      accountIdStringToSdk: (id: string) => id,
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromWebClient(fakeWebClient as any, 'testnet');

    await client.consumeTransaction('acc-id', ['note-1', 'note-2'], false);

    expect(fakeWebClient.newConsumeTransactionRequest).toHaveBeenCalledWith([note1, note2]);
  });

  it('sends transaction without recall blocks', async () => {
    const fakeWebClient = {
      newSendTransactionRequest: jest.fn(() => ({})),
      executeTransaction: jest.fn(async () => ({
        serialize: () => new Uint8Array([7, 8])
      }))
    };

    jest.doMock('./helpers', () => ({
      accountIdStringToSdk: (id: string) => id,
      getBech32AddressFromAccountId: (id: any) => String(id)
    }));
    jest.doMock('../helpers', () => ({ toNoteType: jest.fn(() => 'public') }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromWebClient(fakeWebClient as any, 'testnet');

    const result = await client.sendTransaction({
      accountId: 'sender',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      noteType: 'public' as any,
      amount: BigInt(100),
      extraInputs: {}
    } as any);

    expect(result).toEqual(new Uint8Array([7, 8]));
    expect(fakeWebClient.newSendTransactionRequest).toHaveBeenCalled();
  });
});
