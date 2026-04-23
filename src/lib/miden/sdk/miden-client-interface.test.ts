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
    jest.doMock('lib/miden/activity/connectivity-issues', () => ({
      addConnectivityIssue: jest.fn()
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

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
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

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
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
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
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

  it('consumeNoteId returns TransactionResult', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
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

  describe('miscellaneous branches', () => {
    it('create() returns a mock-network client when MIDEN_USE_MOCK_CLIENT=true', async () => {
      const fakeMockClient = buildFakeMidenClient();
      const createMock = jest.fn(async () => fakeMockClient);

      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
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
      jest.doMock('lib/miden-chain/constants', () => ({
        MIDEN_NETWORK_ENDPOINTS: new Map([['localnet', 'rpc']]),
        MIDEN_PROVING_ENDPOINTS: new Map(),
        getNoteTransportUrl: () => undefined,
        DEFAULT_NETWORK: 'localnet',
        MIDEN_NETWORK_NAME: { LOCALNET: 'localnet', DEVNET: 'devnet', TESTNET: 'testnet' }
      }));
      jest.doMock('./helpers', () => ({ getBech32AddressFromAccountId: (id: any) => String(id) }));
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
      jest.doMock('lib/miden-chain/constants', () => ({
        MIDEN_NETWORK_ENDPOINTS: new Map([['localnet', 'rpc']]),
        MIDEN_PROVING_ENDPOINTS: new Map(),
        getNoteTransportUrl: () => undefined,
        DEFAULT_NETWORK: 'localnet',
        MIDEN_NETWORK_NAME: { LOCALNET: 'localnet', DEVNET: 'devnet', TESTNET: 'testnet' }
      }));
      jest.doMock('./helpers', () => ({ getBech32AddressFromAccountId: (id: any) => String(id) }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({ addConnectivityIssue: jest.fn() }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      await MidenClientInterface.create({}); // no callbacks → hasKeystore=false → keystore: undefined

      expect(createReal).toHaveBeenCalledWith(
        expect.objectContaining({
          keystore: undefined
        })
      );
    });

    it('createMidenWallet routes a Guardian wallet type to createGuardianAccount', async () => {
      const fakeMidenClient = buildFakeMidenClient();
      const createGuardianAccount = jest.fn(async () => ({
        id: () => ({ toString: () => 'guardian-id' })
      }));

      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => (typeof id === 'function' ? id().toString() : String(id))
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

      const result = await client.createMidenWallet('guardian' as any, new Uint8Array([9]));

      expect(createGuardianAccount).toHaveBeenCalledWith(fakeMidenClient, expect.any(Uint8Array));
      expect(result).toBe('guardian-id');
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

  describe('importAccountBySeed', () => {
    it('falls through to importPublicMidenWalletFromSeed for non-Guardian accounts', async () => {
      const fakeMidenClient = buildFakeMidenClient({
        accounts: {
          import: jest.fn(async () => ({ id: () => 'public-acc-id' }))
        }
      });

      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id)
      }));
      jest.doMock('screens/onboarding/types', () => ({
        WalletType: { OnChain: 'on-chain', OffChain: 'off-chain', Guardian: 'guardian' }
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({
        addConnectivityIssue: jest.fn()
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const result = await client.importAccountBySeed(
        'on-chain' as any,
        new Uint8Array([1, 2, 3]),
        jest.fn(async () => '0xsig'),
        jest.fn(async () => 'pk')
      );

      expect(result).toBe('public-acc-id');
      expect(fakeMidenClient.accounts.import).toHaveBeenCalledWith({ seed: expect.any(Uint8Array) });
    });

    it('Guardian path: creates the account locally and re-hydrates state from the guardian', async () => {
      const fakeMidenClient = buildFakeMidenClient();
      const createGuardianAccount = jest.fn(async () => ({
        id: () => ({ toString: () => 'guardian-acc-id' })
      }));
      const getSignerDetailsFromAccount = jest.fn(async () => ({ commitment: 'abc', publicKey: 'def' }));
      const importAccountFromGuardian = jest.fn(async () => {});

      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => (typeof id === 'function' ? id().toString() : String(id))
      }));
      jest.doMock('screens/onboarding/types', () => ({
        WalletType: { OnChain: 'on-chain', OffChain: 'off-chain', Guardian: 'guardian' }
      }));
      jest.doMock('../guardian/account', () => ({
        createGuardianAccount,
        getSignerDetailsFromAccount
      }));
      jest.doMock('../guardian/index', () => ({
        MultisigService: { importAccountFromGuardian }
      }));
      jest.doMock('lib/miden-chain/constants', () => ({
        DEFAULT_GUARDIAN_ENDPOINT: 'https://default.guardian.test'
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({
        addConnectivityIssue: jest.fn()
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      const signWordFn = jest.fn(async () => '0xsig');
      const getPublicKeyForCommitment = jest.fn(async () => 'pk');
      const result = await client.importAccountBySeed(
        'guardian' as any,
        new Uint8Array([1, 2, 3, 4]),
        signWordFn,
        getPublicKeyForCommitment
      );

      expect(createGuardianAccount).toHaveBeenCalledWith(
        fakeMidenClient,
        expect.any(Uint8Array),
        true,
        'https://default.guardian.test'
      );
      expect(getSignerDetailsFromAccount).toHaveBeenCalled();
      expect(importAccountFromGuardian).toHaveBeenCalledWith(
        '0xdef',
        '0xabc',
        signWordFn,
        'guardian-acc-id',
        fakeMidenClient
      );
      expect(result).toBe('guardian-acc-id');
    });

    it('Guardian path: wraps underlying errors in a "Failed to import Guardian account from seed" message', async () => {
      const fakeMidenClient = buildFakeMidenClient();

      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => String(id)
      }));
      jest.doMock('screens/onboarding/types', () => ({
        WalletType: { OnChain: 'on-chain', OffChain: 'off-chain', Guardian: 'guardian' }
      }));
      jest.doMock('../guardian/account', () => ({
        createGuardianAccount: jest.fn(async () => {
          throw new Error('guardian down');
        }),
        getSignerDetailsFromAccount: jest.fn()
      }));
      jest.doMock('../guardian/index', () => ({
        MultisigService: { importAccountFromGuardian: jest.fn() }
      }));
      jest.doMock('lib/miden-chain/constants', () => ({
        DEFAULT_GUARDIAN_ENDPOINT: 'https://default.guardian.test'
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({
        addConnectivityIssue: jest.fn()
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await expect(
        client.importAccountBySeed(
          'guardian' as any,
          new Uint8Array([1]),
          jest.fn(async () => '0xsig'),
          jest.fn(async () => 'pk')
        )
      ).rejects.toThrow('Failed to import Guardian account from seed');
    });
  });

  describe('withProverFallback connectivity-issue classification', () => {
    // Build a client that fails the first (delegate) call with a provided error and
    // succeeds the second (local-prover) call. Returns the addConnectivityIssue spy so
    // the caller can assert whether it fired.
    async function runDelegateFailureCase(err: Error) {
      const addConnectivityIssue = jest.fn();
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
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({ addConnectivityIssue }));

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
      return { addConnectivityIssue };
    }

    it('does NOT mark connectivity issue for "note has already been consumed"', async () => {
      const { addConnectivityIssue } = await runDelegateFailureCase(
        new Error('failed to execute transaction: invalid transaction request: note 0xdead has already been consumed')
      );
      expect(addConnectivityIssue).not.toHaveBeenCalled();
    });

    it('rethrows immediately without local-prover retry when delegateTransaction=false', async () => {
      // shouldDelegate=false → the local-prover-fallback branch is skipped and
      // the error bubbles straight through the `throw err` line.
      const addConnectivityIssue = jest.fn();
      const consume = jest.fn().mockRejectedValueOnce(new Error('prover unreachable'));
      const fakeMidenClient = buildFakeMidenClient({ transactions: { consume } });

      jest.doMock('@miden-sdk/miden-sdk', () => ({
        TransactionProver: { newLocalProver: jest.fn(() => 'local') }
      }));
      jest.doMock('lib/miden/activity/connectivity-issues', () => ({ addConnectivityIssue }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      await expect(
        client.consumeNoteId({
          accountId: 'acc-id',
          noteId: 'note-1',
          type: 'consume',
          delegateTransaction: false
        } as any)
      ).rejects.toThrow('prover unreachable');

      // Called once (no local-prover retry) and banner untouched.
      expect(consume).toHaveBeenCalledTimes(1);
      expect(addConnectivityIssue).not.toHaveBeenCalled();
    });

    it('does NOT mark connectivity issue for "invalid transaction request"', async () => {
      const { addConnectivityIssue } = await runDelegateFailureCase(
        new Error('invalid transaction request: something else went wrong')
      );
      expect(addConnectivityIssue).not.toHaveBeenCalled();
    });

    it('DOES mark connectivity issue on "Failed to fetch"', async () => {
      const { addConnectivityIssue } = await runDelegateFailureCase(new Error('Failed to fetch'));
      expect(addConnectivityIssue).toHaveBeenCalled();
    });

    it('DOES mark connectivity issue on 502 Bad Gateway', async () => {
      const { addConnectivityIssue } = await runDelegateFailureCase(
        new Error('prover responded with status code 502: Bad Gateway')
      );
      expect(addConnectivityIssue).toHaveBeenCalled();
    });

    it('DOES mark connectivity issue on abort / timeout', async () => {
      const { addConnectivityIssue } = await runDelegateFailureCase(new Error('The operation was aborted'));
      expect(addConnectivityIssue).toHaveBeenCalled();
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
    ])('DOES mark connectivity issue for %p', async message => {
      const { addConnectivityIssue } = await runDelegateFailureCase(new Error(message));
      expect(addConnectivityIssue).toHaveBeenCalled();
    });

    it.each([['note has already been consumed'], ['some unrecognized wasm error']])(
      'does NOT mark connectivity issue for %p',
      async message => {
        const { addConnectivityIssue } = await runDelegateFailureCase(new Error(message));
        expect(addConnectivityIssue).not.toHaveBeenCalled();
      }
    );
  });
});
