import { nativeStorageWasm } from './test-fixtures/nativeStorageCapability';

type MidenClientInterfaceType = import('./miden-client-interface').MidenClientInterface;

jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  recordSyncedFeeFaucetId: jest.fn(async () => true)
}));

describe('MidenClientInterface', () => {
  const acquisitionCleanup: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of acquisitionCleanup.splice(0)) cleanup();
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
      inputNotes: () => ({ notes: () => [] }),
      userOutputNotes: () => []
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
                ],
                nonFungibleAssets: () => []
              })
            })
          }
        ]),
        listAvailable: jest.fn(async () => []),
        import: jest.fn(async () => 'note'),
        export: jest.fn(async () => ({ serialize: () => new Uint8Array([1]) })),
        sendPrivateOutput: jest.fn(async () => undefined),
        sendPrivate: jest.fn(async () => undefined),
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
      feeFaucetId: jest.fn(async () => ({ toString: () => '0x817edea77acc5d71616e493afecea3' })),
      sync: jest.fn(async () => ({ blockNum: () => 5 })),
      getSyncHeight: jest.fn(async () => 5),
      storeIdentifier: jest.fn(() => 'test-store'),
      terminate: jest.fn(),
      defaultProver: null,
      ...overrides
    };
  }

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
  async function importWithReader(
    createClient: jest.Mock,
    getRpcUrl: () => string = () => 'https://rpc.example',
    getFeeFaucetId: () => string | undefined = () => '0xfee',
    accountFromBech32: jest.Mock = fromBech32
  ) {
    // The real backoff curve with no jitter, on a test clock (as the sync-backoff tests drive it).
    const clock = { now: 0 };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    readerSpies.push(
      jest.spyOn(performance, 'now').mockImplementation(() => clock.now),
      warn
    );
    readerDoMock('@miden-sdk/miden-sdk/lazy', () => ({
      NoteType: { Private: 0, Public: 1 },
      ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
      NoteScript: {
        p2ide: () => ({ root: () => ({ toHex: () => P2IDE_ROOT }) }),
        feeSponsorship: () => ({ root: () => ({ toHex: () => '0xsponsorship' }) })
      },
      getWasmOrThrow: jest.fn(async () => ({
        ...nativeStorageWasm(),
        AccountId: { fromBech32: accountFromBech32, fromHex: jest.fn() }
      })),
      WasmWebClient: { createClient }
    }));
    readerDoMock('lib/miden-chain/effective-endpoints', () => ({
      getEffectiveNetworkName: () => 'testnet',
      getEffectiveRpcUrl: () => getRpcUrl(),
      getEffectiveProverUrl: () => undefined,
      getEffectiveNoteTransportUrl: () => undefined,
      getEffectiveFeeFaucetId: () => getFeeFaucetId()
    }));
    readerDoMock('lib/miden/sync-backoff', () => {
      const actual = jest.requireActual<typeof import('lib/miden/sync-backoff')>('lib/miden/sync-backoff');
      return {
        ...actual,
        computeSyncBackoffMs: (tripCount: number) => actual.computeSyncBackoffMs(tripCount, () => 0)
      };
    });
    readerDoMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));
    const { MidenClientInterface } = await import('./miden-client-interface');
    const { bumpWasmClientGeneration } = await import('./wasm-client-poison');
    const makeClient = (
      getSyncHeight: jest.Mock = jest.fn(async () => 10),
      overrides: Record<string, any> = {}
    ): MidenClientInterfaceType =>
      Reflect.apply(MidenClientInterface.fromClient, MidenClientInterface, [
        buildFakeMidenClient({ getSyncHeight, ...overrides }),
        'testnet'
      ]);
    return { makeClient, bumpWasmClientGeneration, clock, log: logSpy, warn };
  }
  const emptyReader = () => ({ getConsumableNotes: jest.fn(async () => []) });
  // Miden 0.17 P2IDE storage: [reclaimer.suffix, reclaimer.prefix, target.suffix, target.prefix, reclaim, timelock].
  const P2IDE_ROOT = '0xp2ide';
  const QUERIED = { prefix: 0x00000000abcdef01n, suffix: 0x2f1a3b4c5d6e0000n };
  const OTHER = { prefix: 0x00000000feedbeefn, suffix: 0x7c9d1e2f3a4b0000n };
  const queriedAccount = jest.fn(() => ({
    prefix: () => ({ asInt: () => QUERIED.prefix }),
    suffix: () => ({ asInt: () => QUERIED.suffix })
  }));
  const p2ideRecipient = (target: typeof QUERIED, reclaimHeight: bigint) => ({
    script: () => ({ root: () => ({ toHex: () => P2IDE_ROOT }) }),
    storage: () => ({
      items: () =>
        [QUERIED.suffix, QUERIED.prefix, target.suffix, target.prefix, reclaimHeight, 0n].map(value => ({
          asInt: () => value
        }))
    })
  });
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
    expect(createClient).toHaveBeenCalledWith(
      'https://rpc.example',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      '0xfee',
      undefined,
      undefined,
      { durability: 'strict', onFailure: expect.any(Function) }
    );
    expect(fromBech32).toHaveBeenCalledWith('mtst1account');
    expect(getConsumableNotes).toHaveBeenCalledWith({ accountId: 'mtst1account' });
    // One build line for the realm, however many interfaces read through it.
    const builds = readerLines(log, 'building');
    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain('(first build)');
    expect(builds[0]).toContain(' at rpc.example');
    expect(builds[0]).not.toContain('strands');
  });

  // The SDK's static P2IDE check reads an absent reclaim height as 0 and answers the reclaimer (usually the sender)
  // "consumable now" (0xMiden/protocol#3675), while the script refuses every non-target at a reclaim height of 0.
  it('drops a P2IDE this account can never consume, and keeps one it can', async () => {
    const consumableNow = (note: object) => ({
      inputNoteRecord: () => note,
      noteConsumability: () => [{ consumptionStatus: () => ({ consumableAfterBlock: () => undefined }) }]
    });
    const reclaimDisabled = { id: 'reclaim-disabled', details: () => ({ recipient: () => p2ideRecipient(OTHER, 0n) }) };
    const reclaimReached = { id: 'reclaim-reached', details: () => ({ recipient: () => p2ideRecipient(OTHER, 5n) }) };
    const ownTarget = { id: 'own-target', details: () => ({ recipient: () => p2ideRecipient(QUERIED, 0n) }) };
    const getConsumableNotes = jest.fn(async () => [
      consumableNow(reclaimDisabled),
      consumableNow(reclaimReached),
      consumableNow(ownTarget)
    ]);
    const { makeClient } = await importWithReader(
      jest.fn(async () => ({ getConsumableNotes })),
      undefined,
      undefined,
      queriedAccount
    );

    await expect(makeClient().getConsumableNotes('mtst1account')).resolves.toEqual([reclaimReached, ownTarget]);
    expect(queriedAccount).toHaveBeenCalledWith('mtst1account');
  });

  it('names the one account that can consume a stored reclaim-disabled P2IDE in its details', async () => {
    const stored = (id: string, target: typeof QUERIED, reclaimHeight: bigint) => ({
      id: () => ({ toString: () => id }),
      nullifier: () => `nullifier-${id}`,
      metadata: () => undefined,
      state: () => 0,
      details: () => ({
        assets: () => ({ fungibleAssets: () => [], nonFungibleAssets: () => [] }),
        recipient: () => p2ideRecipient(target, reclaimHeight)
      })
    });
    const { makeClient } = await importWithReader(jest.fn(async () => emptyReader()));
    const client = makeClient(undefined, {
      notes: { list: jest.fn(async () => [stored('reclaim-disabled', OTHER, 0n), stored('reclaim-set', OTHER, 9n)]) }
    });

    const [disabled, set] = await client.getInputNoteDetails();
    expect(disabled?.restriction).toEqual({ prefix: OTHER.prefix.toString(), suffix: OTHER.suffix.toString() });
    expect(set).toBeDefined();
    expect(set?.restriction).toBeUndefined();
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
      false,
      undefined,
      '0xfee',
      undefined,
      undefined,
      { durability: 'strict', onFailure: expect.any(Function) }
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

  // An E2E-injected fee faucet or a developer override can change it under the same node (#1482).
  it('rebuilds the reader when the fee faucet changes with the same RPC URL', async () => {
    let feeFaucetId = '0xfee-a';
    const createClient = jest.fn(async () => emptyReader());
    const { makeClient, log } = await importWithReader(createClient, undefined, () => feeFaucetId);
    const client = makeClient();

    await client.getConsumableNotes('mtst1account');
    feeFaucetId = '0xfee-b';
    await client.getConsumableNotes('mtst1account');
    await client.getConsumableNotes('mtst1account');
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenLastCalledWith(
      'https://rpc.example',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      '0xfee-b',
      undefined,
      undefined,
      { durability: 'strict', onFailure: expect.any(Function) }
    );
    expect(readerLines(log, 'building')[1]).toContain('(fee faucet changed)');
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
          fungibleAssets: () => [{ faucetId: () => `faucet-${id}`, amount: () => ({ toString: () => '100' }) }],
          nonFungibleAssets: () => []
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
    const failure = new DOMException(
      'Unable to open database file at /private/0xfeed for balance 12.5',
      'UnknownError'
    );
    const createClient = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(async () => emptyReader());
    const { makeClient, clock, log, warn } = await importWithReader(createClient);
    const client = makeClient();

    await expect(client.getConsumableNotes('mtst1account')).rejects.toBe(failure);
    const { snapshotCrashDiagnostics } = await import('lib/telemetry/crash-diagnostics');
    expect(snapshotCrashDiagnostics(failure)).toMatchObject({
      operation: 'sdk_initialize',
      stage: 'client_create',
      workerMode: 'disabled',
      clientRole: 'realm_reader'
    });
    expect(JSON.stringify(snapshotCrashDiagnostics(failure))).not.toMatch(/0xfeed|private|12\.5/);
    // A failed build may have stranded its store connection, so inside the window there is no new build.
    clock.now += 29_999;
    await expect(client.getConsumableNotes('mtst1account')).rejects.toBe(failure);
    expect(createClient).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await expect(client.getConsumableNotes('mtst1account')).resolves.toEqual([]);
    expect(createClient).toHaveBeenCalledTimes(2);
    // One warn for the failed build, naming its window and carrying the error; the read served from the window adds
    // none. The build that ended the window says why it ran, and that it ended the streak.
    expect(readerLines(warn, 'build ')).toEqual([expect.stringContaining('failed (1 in a row) - next build in 30s')]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[realm-reader]'), failure);
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

  it('a build whose fee faucet moved while it was pending backs off only its own key', async () => {
    let feeFaucetId = '0xfee-a';
    const { createClient, build, waitForBuilds } = deferredCreateClient();
    const { makeClient, warn } = await importWithReader(createClient, undefined, () => feeFaucetId);
    const client = makeClient();

    const first = client.getConsumableNotes('mtst1account');
    await waitForBuilds(1);
    feeFaucetId = '0xfee-b';
    build(0).reject(new Error('stale build failed'));
    await expect(first).rejects.toThrow('stale build failed');
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

// Vault arithmetic has its own SDK-read regressions; these fixtures isolate staged proof routing.
jest.mock('lib/miden/swap/balance', () => ({
  getSwapFeeContextSync: jest.fn(() => ({})),
  assertSwapAccountBalance: jest.fn()
}));
