import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import { useEpochStore } from './store';
import { deferred } from './testing/earn-locks';

const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
let mockOwner = OWNER;
const mockStatus = jest.fn();
const mockResolve = jest.fn().mockResolvedValue(undefined);

jest.mock('./bridge', () => ({}));
jest.mock('./client', () => ({ getEvmConnection: async () => ({ address: mockOwner }) }));
jest.mock('./sdk', () => ({ getEpochSdk: async () => ({ getIntentStatus: mockStatus }) }));
jest.mock('lib/miden/activity/bridge-in', () => ({
  registerPendingBridgeIn: jest.fn(),
  resolveBridgeInNoteId: (...args: unknown[]) => mockResolve(...args)
}));
jest.mock('lib/miden/transaction/complete', () => ({ updateBridgedReceivePhase: jest.fn() }));

beforeEach(() => {
  mockOwner = OWNER;
  mockStatus.mockReset();
  mockResolve.mockClear();
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

  expect(mockStatus).toHaveBeenCalledWith(OWNER, '7');
  expect(mockResolve).toHaveBeenCalledWith(OWNER, '7', 'note');
  expect(useEpochStore.getState().midenNoteId).toBe('note');
});
