describe('MidenClientInterface PSWAP cancel request', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('reconstructs the creator output note and uses the fee-aware note cancel builder', async () => {
    const requestBytes = new Uint8Array([20, 14, 7, 6]);
    const newPswapCancelTransactionRequest = jest.fn(async () => ({ serialize: () => requestBytes }));
    const recipient = { kind: 'recipient' };
    const assets = { kind: 'assets' };
    const metadata = { kind: 'metadata', sender: () => ({ toString: () => 'sdk-account-1' }) };
    const record = {
      isConsumed: () => false,
      isCommitted: () => true,
      recipient: () => recipient,
      assets: () => assets,
      metadata: () => metadata
    };
    const mockNoteConstructor = jest.fn(function MockNote() {
      return { id: () => ({ toString: () => 'tip-output-note' }) };
    });

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
      Note: mockNoteConstructor
    }));
    jest.doMock('./helpers', () => ({
      ...jest.requireActual('./helpers'),
      walletAccountIdToSdk: (accountId: string) => ({ toString: () => `sdk-${accountId}` })
    }));

    const inner = { newPswapCancelTransactionRequest };
    const fakeClient = {
      notes: { listSent: jest.fn(async () => [record]) },
      _withInnerWebClient: jest.fn(async (operation: (value: typeof inner) => Promise<unknown>) => operation(inner))
    };
    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = Reflect.apply(MidenClientInterface.fromClient, MidenClientInterface, [fakeClient, 'test']);
    const assertLive = jest.fn();

    await expect(client.buildPswapCancelRequest('account-1', 'tip-output-note', assertLive)).resolves.toEqual(
      requestBytes
    );

    expect(fakeClient.notes.listSent).toHaveBeenCalledWith({ ids: ['tip-output-note'] });
    expect(mockNoteConstructor).toHaveBeenCalledWith(assets, metadata, recipient);
    expect(newPswapCancelTransactionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(Function) }),
      expect.objectContaining({ toString: expect.any(Function) })
    );
    expect(assertLive).toHaveBeenCalledWith('after the output-note listing');
    expect(assertLive).toHaveBeenCalledWith('after the cancel-request build');
  });

  it('refuses a full output note owned by another account before building', async () => {
    const record = {
      isConsumed: () => false,
      isCommitted: () => true,
      recipient: () => ({}),
      metadata: () => ({ sender: () => ({ toString: () => 'sdk-account-2' }) })
    };
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('@miden-sdk/miden-sdk/lazy'));
    jest.doMock('./helpers', () => ({
      ...jest.requireActual('./helpers'),
      walletAccountIdToSdk: (accountId: string) => ({ toString: () => `sdk-${accountId}` })
    }));
    const inner = { newPswapCancelTransactionRequest: jest.fn() };
    const fakeClient = {
      notes: { listSent: jest.fn(async () => [record]) },
      _withInnerWebClient: jest.fn(async (operation: (value: typeof inner) => Promise<unknown>) => operation(inner))
    };
    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = Reflect.apply(MidenClientInterface.fromClient, MidenClientInterface, [fakeClient, 'test']);

    await expect(client.buildPswapCancelRequest('account-1', 'tip-output-note')).rejects.toThrow(
      'was not created by account account-1'
    );
    expect(inner.newPswapCancelTransactionRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined, 'is not tracked'],
    [
      'consumed',
      {
        isConsumed: () => true,
        isCommitted: () => true,
        recipient: () => ({})
      },
      'already consumed'
    ],
    [
      'uncommitted',
      {
        isConsumed: () => false,
        isCommitted: () => false,
        recipient: () => ({})
      },
      'not committed yet'
    ],
    [
      'partial',
      {
        isConsumed: () => false,
        isCommitted: () => true,
        recipient: () => undefined
      },
      'has no recipient details'
    ]
  ])('refuses a %s output-note record before building', async (_label, record, expected) => {
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('@miden-sdk/miden-sdk/lazy'));
    const inner = { newPswapCancelTransactionRequest: jest.fn() };
    const fakeClient = {
      notes: { listSent: jest.fn(async () => (record === undefined ? [] : [record])) },
      _withInnerWebClient: jest.fn(async (operation: (value: typeof inner) => Promise<unknown>) => operation(inner))
    };
    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = Reflect.apply(MidenClientInterface.fromClient, MidenClientInterface, [fakeClient, 'test']);

    await expect(client.buildPswapCancelRequest('account-1', 'tip-output-note')).rejects.toThrow(expected);
    expect(inner.newPswapCancelTransactionRequest).not.toHaveBeenCalled();
  });
});

// A recovered device never created the order note, so its output-note store has no record of it (#1487).
describe('MidenClientInterface PSWAP cancel request from the node', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  const arrange = async (records: unknown[], read: unknown) => {
    const requestBytes = new Uint8Array([9, 8, 7]);
    const readPswapOrderNote = jest.fn(async () => read);
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('@miden-sdk/miden-sdk/lazy'));
    jest.doMock('./helpers', () => ({
      ...jest.requireActual('./helpers'),
      walletAccountIdToSdk: (accountId: string) => ({ toString: () => `sdk-${accountId}` })
    }));
    jest.doMock('./pswap-order-note', () => ({ readPswapOrderNote }));
    const inner = { newPswapCancelTransactionRequest: jest.fn(async () => ({ serialize: () => requestBytes })) };
    const fakeClient = {
      notes: { listSent: jest.fn(async () => records) },
      _withInnerWebClient: jest.fn(async (operation: (value: typeof inner) => Promise<unknown>) => operation(inner))
    };
    const { MidenClientInterface } = await import('./miden-client-interface');
    const client = Reflect.apply(MidenClientInterface.fromClient, MidenClientInterface, [fakeClient, 'test']);
    return { client, inner, readPswapOrderNote, requestBytes };
  };

  it("builds the cancel from the node's public order note when the caller allows it", async () => {
    const nodeNote = { id: () => ({ toString: () => 'order-note' }) };
    const { client, inner, readPswapOrderNote, requestBytes } = await arrange([], { kind: 'open', note: nodeNote });
    const assertLive = jest.fn();

    await expect(
      client.buildPswapCancelRequest('account-1', 'order-note', assertLive, { allowNodeNote: true })
    ).resolves.toEqual(requestBytes);

    expect(readPswapOrderNote).toHaveBeenCalledWith('order-note', 'account-1');
    expect(inner.newPswapCancelTransactionRequest).toHaveBeenCalledWith(
      nodeNote,
      expect.objectContaining({ toString: expect.any(Function) })
    );
    expect(assertLive).toHaveBeenCalledWith('after the node note read');
    expect(assertLive).toHaveBeenCalledWith('after the cancel-request build');
  });

  it.each([
    ['spent', { kind: 'spent' }, 'is already consumed on chain'],
    ['absent', { kind: 'absent' }, 'is not a public order note of account account-1']
  ])('refuses an order note the node reads as %s, before building', async (_label, read, expected) => {
    const { client, inner } = await arrange([], read);

    await expect(
      client.buildPswapCancelRequest('account-1', 'order-note', undefined, { allowNodeNote: true })
    ).rejects.toThrow(expected);
    expect(inner.newPswapCancelTransactionRequest).not.toHaveBeenCalled();
  });

  it('asks the node nothing for a caller that does not allow it', async () => {
    const { client, inner, readPswapOrderNote } = await arrange([], { kind: 'open', note: {} });

    await expect(client.buildPswapCancelRequest('account-1', 'order-note')).rejects.toThrow('is not tracked');
    expect(readPswapOrderNote).not.toHaveBeenCalled();
    expect(inner.newPswapCancelTransactionRequest).not.toHaveBeenCalled();
  });

  it('keeps refusing a consumed output record without asking the node', async () => {
    const consumedRecord = { isConsumed: () => true, isCommitted: () => true, recipient: () => ({}) };
    const { client, readPswapOrderNote } = await arrange([consumedRecord], { kind: 'open', note: {} });

    await expect(
      client.buildPswapCancelRequest('account-1', 'order-note', undefined, { allowNodeNote: true })
    ).rejects.toThrow('already consumed');
    expect(readPswapOrderNote).not.toHaveBeenCalled();
  });
});
