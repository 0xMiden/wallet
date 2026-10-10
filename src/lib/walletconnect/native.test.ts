import { type NativeFeeFields, readNativeFeeFields } from './fees';
import { buildNativeReownProvider } from './native';

const mockSendTransaction = jest.fn();
jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ sendTransaction: (...args: unknown[]) => mockSendTransaction(...args) })
}));
jest.mock('lib/platform', () => ({ isAndroid: () => false, isIOS: () => true }));
jest.mock('./fees', () => ({ readNativeFeeFields: jest.fn() }));

const ESTIMATE: NativeFeeFields = { maxFeePerGas: '0x64', maxPriorityFeePerGas: '0x2' };
const provider = buildNativeReownProvider({ chainId: 11155111, address: '0xowner', rpcUrl: 'https://rpc.test' });
const send = (tx: Record<string, string>) =>
  provider.request({ method: 'eth_sendTransaction', params: [{ to: '0xto', data: '0x', ...tx }] });

beforeEach(() => {
  jest.clearAllMocks();
  mockSendTransaction.mockResolvedValue({ hash: '0xhash' });
  jest.mocked(readNativeFeeFields).mockResolvedValue(ESTIMATE);
});

// A caller that set no fee gets fields with headroom; one that set any fee field keeps what it set.
it('sends the fee estimate when the caller set no fee', async () => {
  await send({});

  expect(readNativeFeeFields).toHaveBeenCalledWith(11155111);
  expect(mockSendTransaction).toHaveBeenCalledWith(expect.objectContaining(ESTIMATE));
});

it.each([
  ['gasPrice', { gasPrice: '0x9' }],
  ['maxFeePerGas', { maxFeePerGas: '0x50', maxPriorityFeePerGas: '0x3' }],
  ['only maxPriorityFeePerGas', { maxPriorityFeePerGas: '0x3' }]
])('keeps the fee the caller set with %s and reads no estimate', async (_label, fee) => {
  await send(fee);

  expect(readNativeFeeFields).not.toHaveBeenCalled();
  expect(mockSendTransaction).toHaveBeenCalledWith(expect.objectContaining(fee));
});
