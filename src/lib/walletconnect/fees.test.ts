import { readNativeFeeFields } from './fees';

const getBlock = jest.fn();
const estimateMaxPriorityFeePerGas = jest.fn();

jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  createPublicClient: () => ({ getBlock, estimateMaxPriorityFeePerGas }),
  http: () => undefined
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('readNativeFeeFields', () => {
  it('covers twice the base fee plus the priority fee', async () => {
    getBlock.mockResolvedValue({ baseFeePerGas: 57_676_000n });
    estimateMaxPriorityFeePerGas.mockResolvedValue(1_000n);

    await expect(readNativeFeeFields(421614)).resolves.toEqual({
      maxFeePerGas: `0x${(57_676_000n * 2n + 1_000n).toString(16)}`,
      maxPriorityFeePerGas: '0x3e8'
    });
  });

  it('treats a missing priority estimate as zero', async () => {
    getBlock.mockResolvedValue({ baseFeePerGas: 100n });
    estimateMaxPriorityFeePerGas.mockRejectedValue(new Error('unsupported'));

    await expect(readNativeFeeFields(421614)).resolves.toEqual({ maxFeePerGas: '0xc8', maxPriorityFeePerGas: '0x0' });
  });

  it('leaves the fee to the wallet when the chain has no base fee, is unknown, or the read fails', async () => {
    getBlock.mockResolvedValue({ baseFeePerGas: null });
    await expect(readNativeFeeFields(421614)).resolves.toEqual({});

    await expect(readNativeFeeFields(999)).resolves.toEqual({});
    expect(getBlock).toHaveBeenCalledTimes(1);

    getBlock.mockRejectedValue(new Error('timeout'));
    await expect(readNativeFeeFields(421614)).resolves.toEqual({});
  });
});
