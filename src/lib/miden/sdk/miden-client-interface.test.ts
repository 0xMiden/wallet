type MidenClientInterfaceType = import('./miden-client-interface').MidenClientInterface;

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
      // The non-offscreen send builds its request through the inner raw client.
      // `getAccount` is the sender-vault read that supplies the outgoing asset's
      // callback flag, so it has to exist here or the send path throws.
      _withInnerWebClient: jest.fn(async (fn: (inner: any) => Promise<any>) =>
        fn(
          overrides.__inner ?? {
            newSendTransactionRequest: jest.fn(async () => ({ serialize: () => new Uint8Array([7]) })),
            getAccount: jest.fn(async () => ({ vault: jest.fn() }))
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
      buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
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
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
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

    const result = await client.sendTransaction({
      accountId: 'sender',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      noteType: 'public' as any,
      amount: BigInt(100),
      extraInputs: {}
    } as any);

    expect(result).toBe(fakeTransactionResult);
    // The non-offscreen send drives the staged pipeline (executeRequest → prove →
    // submit → apply), not the all-in-one `transactions.send`.
    expect(fakeMidenClient.transactions.executeRequest).toHaveBeenCalled();
    expect(fakeMidenClient.transactions.send).not.toHaveBeenCalled();
  });

  it('reports executing/proving/submitting stages through the onStage callback', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
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

    const result = await client.sendTransaction({
      accountId: 'sender',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      noteType: 'public' as any,
      amount: BigInt(1),
      extraInputs: {},
      delegateTransaction: true
    } as any);

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
  it.each([
    [
      'submit rejects (the node may still have accepted it)',
      new Error('network error while submitting'),
      'submit' as const
    ],
    [
      'apply rejects after a successful submit',
      new Error(
        "Transaction 0xabc was accepted into the node's mempool at block 42 but the local store update failed."
      ),
      'apply' as const
    ]
  ])(
    'does not re-run the send pipeline when the delegated attempt already reached submit — %s',
    async (_l, err, failAt) => {
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

      // The ORIGINAL error propagates — `generateTransactionsLoop`'s
      // apply-after-submit classification reads the immediate error's message chain.
      await expect(
        client.sendTransaction({
          accountId: 'sender',
          secondaryAccountId: 'recipient',
          faucetId: 'faucet',
          noteType: 'public' as any,
          amount: BigInt(1),
          extraInputs: {},
          delegateTransaction: true
        } as any)
      ).rejects.toBe(err);

      // Exactly one execute and one submit: no second broadcast.
      expect(fakeMidenClient.transactions.executeRequest).toHaveBeenCalledTimes(1);
      expect(submitCalls).toBe(1);
    }
  );

  it('sendTransaction throws a friendly error when _withInnerWebClient is missing', async () => {
    const fakeMidenClient = buildFakeMidenClient({ _withInnerWebClient: undefined });

    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
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
      client.sendTransaction({
        accountId: 'sender',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        noteType: 'public' as any,
        amount: BigInt(1),
        extraInputs: {}
      } as any)
    ).rejects.toThrow(/_withInnerWebClient missing/);
  });

  // The consume leaf drives the SDK's opaque all-in-one `transactions.consume`, so
  // it has no seam at which to mark the point of no return and deliberately keeps
  // the whole-op local-prover retry (the retry re-consumes the SAME notes, so a
  // first attempt that landed is rejected on the spent nullifier). The one case it
  // must NOT retry is apply-after-submit — the tx IS on chain — because the retry's
  // error would replace it and the row would be classified Failed instead of landed.
  it('does not retry an opaque consume whose failure says the node already accepted it', async () => {
    const applyAfterSubmit = new Error(
      "Transaction 0xabc was accepted into the node's mempool at block 42 but the local store update failed."
    );
    const consume = jest.fn(async () => Promise.reject(applyAfterSubmit));
    const fakeMidenClient = buildFakeMidenClient({ transactions: { consume } });

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      TransactionProver: { newLocalProver: jest.fn(() => 'local') }
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await expect(
      client.consumeNoteId({
        accountId: 'acc-id',
        noteId: 'note-1',
        type: 'consume',
        delegateTransaction: true
      } as any)
    ).rejects.toBe(applyAfterSubmit);

    expect(consume).toHaveBeenCalledTimes(1);
  });

  // Swap is the other opaque whole-op write, but unlike consume a retry would mint
  // a SECOND PSWAP note (a fresh note serial) and lock the offered asset twice — so
  // it marks the point of no return before the call and gives up the prove fallback.
  it('does not retry a delegated swap: the PSWAP submit has no seam to stop at', async () => {
    const pswapErr = new Error('remote prover deadline exceeded');
    const submit = jest.fn(async () => Promise.reject(pswapErr));
    const fakeMidenClient = buildFakeMidenClient({
      transactions: { submit },
      // The reference request the vault-key re-emit is measured against.
      __inner: {
        newPswapCreateTransactionRequest: jest.fn(() => ({ serialize: () => new Uint8Array([3]) }))
      }
    });

    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: any) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      buildPswapCreateRequest: jest.fn(() => ({ kind: 'pswap', serialize: () => new Uint8Array([4]) }))
    }));
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      TransactionProver: { newLocalProver: jest.fn(() => 'local') }
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    await expect(
      client.swapTransaction({
        accountId: 'acc-id',
        faucetId: 'offered-faucet',
        amount: BigInt(10),
        type: 'swap',
        delegateTransaction: true,
        extraInputs: { requestedFaucetId: 'wanted-faucet', requestedAmount: BigInt(20) }
      } as any)
    ).rejects.toBe(pswapErr);

    expect(submit).toHaveBeenCalledTimes(1);
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

  it('consumeNoteId returns TransactionResult', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 'Private', Public: 'Public' },
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

  it('consumeNoteId: a delegated consume whose remote prover never answers falls back locally (#718)', async () => {
    // The opaque SDK write has no seam between prove and submit, so a remote prover that
    // goes quiet mid-proof used to park this call forever with the client lock held, and
    // every later claim queued behind it. The whole-op retry is safe for consume alone:
    // it re-consumes the SAME notes, so an attempt that did reach the chain is rejected
    // on the spent nullifier. Only the DELEGATED call is bounded — see the call site.
    jest.useFakeTimers();
    const fakeMidenClient = buildFakeMidenClient();
    // Delegated attempt (no explicit prover) never settles; the local re-prove succeeds.
    fakeMidenClient.transactions.consume
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(async () => ({ result: fakeTransactionResult }));

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 'Private', Public: 'Public' },
      TransactionProver: {
        newLocalProver: jest.fn(() => 'local')
      }
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const { MidenClientInterface, DELEGATED_PROVE_TIMEOUT_MS } = await import('./miden-client-interface');
    const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

    const pending = client.consumeNoteId({
      accountId: 'acc-id',
      noteId: 'note-1',
      type: 'consume',
      delegateTransaction: true
    } as any);

    await jest.advanceTimersByTimeAsync(DELEGATED_PROVE_TIMEOUT_MS);

    expect(await pending).toBe(fakeTransactionResult);
    expect(fakeMidenClient.transactions.consume).toHaveBeenCalledTimes(2);
    // First delegated (prover undefined), then the local prover on the fallback.
    expect(fakeMidenClient.transactions.consume.mock.calls[0][0].prover).toBeUndefined();
    expect(fakeMidenClient.transactions.consume.mock.calls[1][0].prover).toBe('local');
    jest.useRealTimers();
  });

  it('consumeNoteId consumes every noteId in one transaction when a batch is given', async () => {
    const fakeMidenClient = buildFakeMidenClient();

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 'Private', Public: 'Public' },
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

    await client.consumeNoteId({
      accountId: 'acc-id',
      noteId: 'note-1',
      noteIds: ['note-1', 'note-2', 'note-3'],
      type: 'consume'
    } as any);

    // Claim All batches into a single consume (one proof, one submit) rather
    // than falling back to the singular `noteId`.
    expect(fakeMidenClient.transactions.consume).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'acc-id', notes: ['note-1', 'note-2', 'note-3'] })
    );
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
        keys
      }));

      jest.doMock('./helpers', () => ({
        getBech32AddressFromAccountId: (id: any) => (typeof id === 'function' ? id().toString() : String(id)),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
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

      const result = await client.createGuardianMidenWallet(new Uint8Array([9]), 'https://picked-guardian.example');

      // The picked endpoint is forwarded as createGuardianAccount's
      // guardianEndpointOverride (4th arg) so the new account binds to it
      // (stage 1 of #408). skipRegistration (3rd arg) stays false.
      expect(createGuardianAccount).toHaveBeenCalledWith(
        fakeMidenClient,
        expect.any(Uint8Array),
        false,
        'https://picked-guardian.example'
      );
      expect(result).toEqual({ accountId: 'guardian-id', keys });
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
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        NoteType: { Private: 0, Public: 1 },
        TransactionProver: { newLocalProver: jest.fn(() => 'local') }
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));

      const fakeMidenClient = buildFakeMidenClient();
      await jest.isolateModulesAsync(async () => {
        const { MidenClientInterface } = await import('./miden-client-interface');
        const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
        // Should not throw despite the frozen array — the catch swallows it.
        const result = await client.consumeNoteId({
          accountId: 'acc-id',
          noteId: 'note-1',
          type: 'consume'
        } as any);
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
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        NoteType: { Private: 0, Public: 1 },
        TransactionProver: { newLocalProver: jest.fn(() => 'local') }
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));

      const fakeMidenClient = buildFakeMidenClient();
      let consumeResult!: unknown;
      await jest.isolateModulesAsync(async () => {
        const { MidenClientInterface } = await import('./miden-client-interface');
        const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
        consumeResult = await client.consumeNoteId({
          accountId: 'acc-id',
          noteId: 'note-1',
          type: 'consume'
        } as any);
      });

      expect(consumeResult).toBe(fakeTransactionResult);
      const markers = (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__ ?? [];
      expect(markers.length).toBeGreaterThan(0);
      expect(markers.some(l => /consumeNoteId entered/.test(l))).toBe(true);
      expect(markers.some(l => /consumeNoteId SDK consume returned/.test(l))).toBe(true);
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

    const consume = jest.fn().mockResolvedValue({ txId: 'tx-1', result: fakeTransactionResult });
    const fakeMidenClient = buildFakeMidenClient({ transactions: { consume } });

    // Scope doMocks inside isolateModulesAsync so they don't leak to other
    // tests in this file (Jest's doMock state is per-module-registry).
    await jest.isolateModulesAsync(async () => {
      jest.doMock('lib/platform', () => ({
        isMobile: () => true,
        isExtension: () => false,
        isDesktop: () => false
      }));
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        NoteType: { Private: 0, Public: 1 },
        TransactionProver: { newCallbackProver, newLocalProver }
      }));
      jest.doMock('@miden/native-prover', () => ({ MidenNativeProver: nativeProverPlugin }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));

      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
      const result = await client.consumeNoteId({
        accountId: 'acc-id',
        noteId: 'note-1',
        type: 'consume',
        delegateTransaction: false
      } as any);
      expect(result).toBe(fakeTransactionResult);
    });

    // The mobile branch picks newCallbackProver, not newLocalProver.
    expect(newCallbackProver).toHaveBeenCalledTimes(1);
    expect(newLocalProver).not.toHaveBeenCalled();
    // ...and forwards a function (the callback closure) into it.
    const firstCall = newCallbackProver.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(typeof firstCall![0]).toBe('function');

    // The SDK then receives that closure-wrapping prover instance.
    const lastConsumeArgs = consume.mock.calls.at(-1)?.[0];
    expect(lastConsumeArgs?.prover).toBe('callback-prover-instance');

    // Important: jest.doMock persists past jest.resetModules — explicitly
    // undo the mobile/native-prover mocks so the next test's default
    // isMobile()=false / no-native-prover environment is restored.
    jest.dontMock('lib/platform');
    jest.dontMock('@miden/native-prover');
  });

  it('consumeNoteId surfaces SDK exception with name+message in prove-timing log', async () => {
    const prevFlag = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    delete (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__;

    try {
      jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
        NoteType: { Private: 0, Public: 1 },
        TransactionProver: { newLocalProver: jest.fn(() => 'local') }
      }));
      jest.doMock('lib/miden/activity/connectivity-state', () => ({
        markConnectivityIssue: jest.fn(),
        clearConnectivityIssue: jest.fn()
      }));

      const consumeErr = new Error('kernel exec failed');
      consumeErr.name = 'TestKernelError';
      const fakeMidenClient = buildFakeMidenClient({
        transactions: {
          consume: jest.fn().mockRejectedValue(consumeErr)
        }
      });

      await jest.isolateModulesAsync(async () => {
        const { MidenClientInterface } = await import('./miden-client-interface');
        const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');
        await expect(
          client.consumeNoteId({ accountId: 'acc-id', noteId: 'note-1', type: 'consume' } as any)
        ).rejects.toBe(consumeErr);
      });

      const markers = (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__ ?? [];
      expect(markers.some(l => /consumeNoteId SDK consume THREW.*TestKernelError.*kernel exec failed/.test(l))).toBe(
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

    it('rethrows immediately without local-prover retry when delegateTransaction=false', async () => {
      // shouldDelegate=false → the local-prover-fallback branch is skipped and
      // the error bubbles straight through the `throw err` line.
      const markConnectivityIssue = jest.fn();
      const clearConnectivityIssue = jest.fn();
      const consume = jest.fn().mockRejectedValueOnce(new Error('prover unreachable'));
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
        buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
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
        getAccount: jest.fn(async () => undefined),
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
        getAccount: jest.fn(async () => undefined),
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
        getAccount: jest.fn(async () => undefined),
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
        getAccount: jest.fn(async () => undefined),
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

      // Exactly one deserialize: the one inside proveLocallyViaOffscreen's builder
      // closure. `newTransaction` no longer deserializes eagerly at the top of the
      // method — a wasm-bindgen request is consumed by execution, so each attempt
      // now hydrates its own from the bytes.
      expect(txRequestDeserialize).toHaveBeenCalledTimes(1);
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
        getAccount: jest.fn(async () => undefined),
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
        getBech32AddressFromAccountId: (id: any) => String(id),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
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

    it('throws when _withInnerWebClient is missing on the client', async () => {
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
        getBech32AddressFromAccountId: (id: any) => String(id),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        buildSendTransactionRequest: jest.fn(() => ({ kind: 'request', serialize: () => new Uint8Array([1]) }))
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

      // No _withInnerWebClient attached (override the default stub away).
      const fakeMidenClient = buildFakeMidenClient({ _withInnerWebClient: undefined });
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
      ).rejects.toThrow(/_withInnerWebClient missing/);
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
      // A marker account, NOT undefined: this is the offscreen/speculation path,
      // which is the shipping default, and it is where the sender's vault key
      // (callback flag included) has to reach the builder. With `undefined` here
      // the builder falls through to `new FungibleAsset(...)` — the default
      // Disabled flag, i.e. the exact bug this PR fixes — and nothing notices.
      const senderAccount = { tag: 'sender-account' };
      const inner = {
        executeTransaction: jest.fn(async () => txResult),
        getAccount: jest.fn(async () => senderAccount),
        newSendTransactionRequest: jest.fn(async () => ({ kind: 'request' }))
      };
      const buildSendTransactionRequest = jest.fn(() => ({
        kind: 'request',
        serialize: () => new Uint8Array([1])
      }));
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
        getBech32AddressFromAccountId: (id: any) => String(id),
        walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
        buildSendTransactionRequest
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
      (fakeMidenClient as any)._withInnerWebClient = async (fn: any) => fn(inner);
      const { MidenClientInterface } = await import('./miden-client-interface');
      const client = MidenClientInterface.fromClient(fakeMidenClient as any, 'testnet');

      // Composite `<address>_<suffix>` sender: `resolveAccountId` must strip the
      // suffix before parsing, or the bech32 parser sees a string it can reject.
      const entry = await client.executeAndProveForSpeculation({
        accountId: 'mtst1sender_qr7qqq9wr6w',
        // Uppercase '0X' too: `AccountId.fromHex` throws on it, so a reference
        // that is otherwise valid would fail to resolve here.
        recipientAccountId: '0XRecipient',
        faucetId: 'mtst1faucet',
        noteType: 'private',
        amount: 250n
      });

      expect(entry.paramsHash).toBe('mtst1sender_qr7qqq9wr6w|0XRecipient|mtst1faucet|private|250');
      expect(entry.txResultBytes).toEqual(new Uint8Array([0xa, 0xb]));
      expect(new Uint8Array(entry.provenBytes)).toEqual(new Uint8Array([0xc, 0xd]));

      // Account ID resolution: accounts beginning with 0x → fromHex (with the
      // prefix lowercased, and only the prefix), otherwise → fromBech32, and
      // the composite suffix is stripped first.
      expect(fakeWasm.AccountId.fromBech32).toHaveBeenCalledWith('mtst1sender');
      expect(fakeWasm.AccountId.fromHex).toHaveBeenCalledWith('0xRecipient');
      expect(proveViaOffscreen).toHaveBeenCalledWith(expect.any(Uint8Array), null, { speculative: true });

      // The whole point of the PR on the DEFAULT send path: the sender's account
      // — and therefore its vault key, callback flag included — reaches the
      // builder. Passing `undefined` here falls back to `new FungibleAsset(...)`
      // and its default Disabled flag, which is the bug being fixed.
      expect(inner.getAccount).toHaveBeenCalled();
      expect(buildSendTransactionRequest).toHaveBeenCalledWith(
        senderAccount,
        expect.anything(),
        expect.anything(),
        'mtst1faucet',
        250n,
        'Private',
        undefined
      );
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

      await client.importNoteBytes(new Uint8Array([1, 2]));

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

      await client.importNoteBytes(new Uint8Array([9, 9, 9]));

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

      await client.importNoteBytes(new Uint8Array([9, 9, 9]));

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

      await expect(client.importNoteBytes(new Uint8Array([0]))).rejects.toThrow(
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

      await expect(client.importNoteBytes(new Uint8Array([0]))).rejects.toThrow(
        /NoteFile parse error: raw-notefile-failure; Note parse error: raw-note-failure/
      );
      expect(importMock).not.toHaveBeenCalled();
    });
  });

  // Keep this module-mock-backed case last: jest.doMock registrations survive
  // jest.resetModules(), and this deliberately narrow SDK surface must not
  // replace the richer mocks used by the tests above.
  it('filters notes gated beyond the sync height and terminates the transient client', async () => {
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
    const terminate = jest.fn();
    const createClient = jest.fn(async () => ({ getConsumableNotes, terminate }));
    const fromBech32 = jest.fn((accountId: string) => ({ accountId }));

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
      getWasmOrThrow: jest.fn(async () => ({
        AccountId: { fromBech32, fromHex: jest.fn() }
      })),
      WasmWebClient: { createClient }
    }));
    jest.doMock('lib/miden-chain/effective-endpoints', () => ({
      getEffectiveNetworkName: () => 'testnet',
      getEffectiveRpcUrl: () => 'https://rpc.example',
      getEffectiveProverUrl: () => undefined,
      getEffectiveNoteTransportUrl: () => undefined
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));

    const fakeMidenClient = buildFakeMidenClient({
      getSyncHeight: jest.fn(async () => 10)
    });
    const { MidenClientInterface } = await import('./miden-client-interface');
    const client: MidenClientInterfaceType = Reflect.apply(MidenClientInterface.fromClient, MidenClientInterface, [
      fakeMidenClient,
      'testnet'
    ]);

    await expect(client.getConsumableNotes('mtst1account')).resolves.toEqual([currentlyConsumable, ungated]);
    // The trailing `false` is `useWorker` (the SDK's 6th positional parameter, which
    // defaults to TRUE). It has to be explicit: this read runs in the offscreen
    // document whenever MIDEN_USE_OFFSCREEN_CLIENT is on — the Chrome default for the
    // SW bundle — and an offscreen document is a real document where `Worker` exists,
    // so the default would spawn a Web Worker plus a second WASM instance on every
    // sync tick / claimable-notes refresh / dApp note query and then tear it down.
    // (In an MV3 service worker `Worker` is undefined, which is why the omission was
    // invisible before the offscreen rehost.)
    expect(createClient).toHaveBeenCalledWith('https://rpc.example', undefined, undefined, undefined, undefined, false);
    expect(fromBech32).toHaveBeenCalledWith('mtst1account');
    expect(getConsumableNotes).toHaveBeenCalledWith({ accountId: 'mtst1account' });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  // Keep this after the gate test above: it reuses the same jest.doMock surface.
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
    const terminate = jest.fn();
    const createClient = jest.fn(async () => ({ getConsumableNotes, terminate }));
    const fromBech32 = jest.fn((accountId: string) => ({ accountId }));

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
      getWasmOrThrow: jest.fn(async () => ({ AccountId: { fromBech32, fromHex: jest.fn() } })),
      WasmWebClient: { createClient }
    }));
    jest.doMock('lib/miden-chain/effective-endpoints', () => ({
      getEffectiveNetworkName: () => 'testnet',
      getEffectiveRpcUrl: () => 'https://rpc.example',
      getEffectiveProverUrl: () => undefined,
      getEffectiveNoteTransportUrl: () => undefined
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));
    // The reducer bech32-encodes account ids; stub to a recognizable transform.
    jest.doMock('./helpers', () => ({
      ...jest.requireActual('./helpers'),
      getBech32AddressFromAccountId: (accountId: unknown) => `bech32(${String(accountId)})`
    }));

    const fakeMidenClient = buildFakeMidenClient({ getSyncHeight: jest.fn(async () => 10) });
    const { MidenClientInterface } = await import('./miden-client-interface');
    const client: MidenClientInterfaceType = Reflect.apply(MidenClientInterface.fromClient, MidenClientInterface, [
      fakeMidenClient,
      'testnet'
    ]);

    // Only the kept (non-gated) note survives, reduced to a full DTO.
    await expect(client.getConsumableNoteDtos('mtst1account')).resolves.toEqual([
      {
        noteId: 'kept',
        nullifier: 'null-kept',
        noteType: 1,
        senderAccountId: 'bech32(sender-kept)',
        state: 2,
        assets: [{ amount: '100', faucetId: 'bech32(faucet-kept)' }],
        swapAttachment: null
      }
    ]);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
