import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import { EPOCH_INTENT_STATUS_TIMEOUT_MS } from './intent-status';
import { useEpochStore } from './store';
import { deferred } from './testing/earn-locks';

const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
let mockOwner = OWNER;
const mockStatus = jest.fn();
const mockResolve = jest.fn().mockResolvedValue(undefined);

jest.mock('./bridge', () => ({}));
const mockConnection = jest.fn();
const mockGetSdk = jest.fn();

jest.mock('./client', () => ({ getEvmConnection: () => mockConnection() }));
jest.mock('./sdk', () => ({ getEpochSdk: () => mockGetSdk() }));
jest.mock('lib/miden/activity/bridge-in', () => ({
  registerPendingBridgeIn: jest.fn(),
  resolveBridgeInNoteId: (...args: unknown[]) => mockResolve(...args)
}));
jest.mock('lib/miden/transaction/complete', () => ({ updateBridgedReceivePhase: jest.fn() }));

beforeEach(() => {
  mockOwner = OWNER;
  mockStatus.mockReset();
  mockConnection.mockReset().mockImplementation(async () => ({ address: mockOwner }));
  mockGetSdk.mockReset().mockImplementation(async () => ({ getIntentStatus: mockStatus }));
  mockResolve.mockReset().mockResolvedValue(undefined);
  useEpochStore.getState().reset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('resolves a discovered note for the captured owner when the connected wallet changes during polling', async () => {
  const started = deferred<void>();
  const response = deferred<Array<{ chainId: number; status: string; midenNoteId: string }>>();
  mockStatus.mockImplementation(() => {
    started.resolve();
    return response.promise;
  });
  useEpochStore.setState({
    flow: 'evm-to-miden',
    status: 'pending',
    intent: { taskTypeString: 'bridge', intentData: {}, intentNonce: '7' },
    pollStartedAt: Date.now()
  });

  const polling = useEpochStore.getState().poll();
  await started.promise;
  mockOwner = OTHER;
  response.resolve([{ chainId: MIDEN_DESTINATION_CHAIN_ID, status: 'success', midenNoteId: 'note' }]);
  await polling;

  expect(mockStatus).toHaveBeenCalledWith(OWNER, '7', expect.any(AbortSignal));
  expect(mockResolve).toHaveBeenCalledWith(OWNER, '7', 'note');
  expect(useEpochStore.getState().midenNoteId).toBe('note');
});

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const pendingDeposit = (nonce: string, pollStartedAt: number) =>
  useEpochStore.setState({
    flow: 'evm-to-miden',
    status: 'pending',
    intent: { taskTypeString: 'bridge', intentData: {}, intentNonce: nonce },
    pollStartedAt
  });

describe('a poll that waits on the allocator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.useRealTimers());

  it('keeps a deposit past the poll limit pending when its status read times out', async () => {
    mockStatus.mockReturnValue(new Promise(() => {}));
    pendingDeposit('8', 0);

    const polling = useEpochStore.getState().poll();
    await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS);
    await polling;

    expect(useEpochStore.getState()).toMatchObject({ status: 'pending', error: null });
  });
  it('lets the next deposit poll while a poll a reset replaced still waits', async () => {
    const started = deferred<void>();
    mockStatus
      .mockImplementationOnce(() => {
        started.resolve();
        return new Promise(() => {});
      })
      .mockResolvedValueOnce([]);
    pendingDeposit('12', 0);
    const replaced = useEpochStore.getState().poll();
    await started.promise;

    useEpochStore.getState().reset();
    pendingDeposit('13', Date.now());
    await useEpochStore.getState().poll();
    expect(mockStatus).toHaveBeenLastCalledWith(OWNER, '13', expect.any(AbortSignal));

    await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS);
    await replaced;
    expect(useEpochStore.getState()).toMatchObject({ status: 'pending', error: null });
  });

  it('keeps the next request to one poll when a replaced poll settles', async () => {
    mockStatus.mockReturnValue(new Promise(() => {}));
    pendingDeposit('14', Date.now());
    const replaced = useEpochStore.getState().poll();
    await jest.advanceTimersByTimeAsync(10_000);

    useEpochStore.getState().reset();
    pendingDeposit('15', Date.now());
    const current = useEpochStore.getState().poll();
    await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS - 10_000);
    await replaced;

    const beside = useEpochStore.getState().poll();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockStatus).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS);
    await Promise.all([current, beside]);
  });

  it('settles a deposit past the poll limit on the answer after a failed read', async () => {
    pendingDeposit('9', 0);
    mockStatus.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useEpochStore.getState().poll();
    expect(useEpochStore.getState()).toMatchObject({ status: 'pending', error: null });

    mockStatus.mockResolvedValueOnce([
      { chainId: MIDEN_DESTINATION_CHAIN_ID, status: 'success', midenNoteId: 'note-9' }
    ]);
    await useEpochStore.getState().poll();
    expect(useEpochStore.getState().status).toBe('done');
  });
});

it('does not start a second poll while one still waits', async () => {
  const response = deferred<unknown[]>();
  mockStatus.mockReturnValue(response.promise);
  pendingDeposit('10', Date.now());

  const first = useEpochStore.getState().poll();
  const second = useEpochStore.getState().poll();
  response.resolve([]);
  await Promise.all([first, second]);

  expect(mockStatus).toHaveBeenCalledTimes(1);
});

it('lets the next poll read when a poll is stuck resolving the wallet connection', async () => {
  mockConnection.mockReturnValueOnce(new Promise(() => {}));
  mockStatus.mockResolvedValue([]);
  pendingDeposit('16', Date.now());

  void useEpochStore.getState().poll();
  await useEpochStore.getState().poll();

  expect(mockStatus).toHaveBeenCalledTimes(1);
});

it('lets the next poll read when a poll is stuck building the Epoch SDK', async () => {
  mockGetSdk.mockReturnValueOnce(new Promise(() => {}));
  mockStatus.mockResolvedValue([]);
  pendingDeposit('17', Date.now());

  void useEpochStore.getState().poll();
  await useEpochStore.getState().poll();

  expect(mockStatus).toHaveBeenCalledTimes(1);
});

it('never reads for a poll a reset replaced while it resolved the wallet connection', async () => {
  const connection = deferred<{ address: string }>();
  const answer = deferred<unknown[]>();
  mockConnection.mockReturnValueOnce(connection.promise);
  mockStatus.mockReturnValue(answer.promise);
  pendingDeposit('19', Date.now());
  const replaced = useEpochStore.getState().poll();

  useEpochStore.getState().reset();
  pendingDeposit('20', Date.now());
  const current = useEpochStore.getState().poll();
  await flush();
  connection.resolve({ address: OWNER });
  await flush();
  const next = useEpochStore.getState().poll();
  await flush();

  expect(mockStatus.mock.calls.map(call => call[1])).toEqual(['20']);
  answer.resolve([]);
  await Promise.all([replaced, current, next]);
});

it('never reads for a poll a reset replaced while it built the Epoch SDK', async () => {
  const sdkSetup = deferred<{ getIntentStatus: typeof mockStatus }>();
  const answer = deferred<unknown[]>();
  mockGetSdk.mockReturnValueOnce(sdkSetup.promise);
  mockStatus.mockReturnValue(answer.promise);
  pendingDeposit('21', Date.now());
  const replaced = useEpochStore.getState().poll();

  useEpochStore.getState().reset();
  pendingDeposit('22', Date.now());
  const current = useEpochStore.getState().poll();
  await flush();
  sdkSetup.resolve({ getIntentStatus: mockStatus });
  await flush();
  const next = useEpochStore.getState().poll();
  await flush();

  expect(mockStatus.mock.calls.map(call => call[1])).toEqual(['22']);
  answer.resolve([]);
  await Promise.all([replaced, current, next]);
});

it('writes nothing for a poll a reset replaced, but still records the note it found', async () => {
  const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const started = deferred<void>();
  const response = deferred<Array<{ chainId: number; status: string; midenNoteId: string }>>();
  mockStatus.mockImplementation(() => {
    started.resolve();
    return response.promise;
  });
  pendingDeposit('11', Date.now());

  const polling = useEpochStore.getState().poll();
  await started.promise;
  useEpochStore.getState().reset();
  response.resolve([{ chainId: MIDEN_DESTINATION_CHAIN_ID, status: 'success', midenNoteId: 'note-11' }]);
  await polling;

  expect(useEpochStore.getState()).toMatchObject({ status: 'idle', pollResults: null, midenNoteId: null });
  expect(mockResolve).toHaveBeenCalledWith(OWNER, '11', 'note-11');
  expect(errors).not.toHaveBeenCalled();
});
