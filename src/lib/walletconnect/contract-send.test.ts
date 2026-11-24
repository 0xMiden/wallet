import { encodeFunctionData, parseAbi, type Hash } from 'viem';

import { sendEvmContractTransaction } from './contract-send';
import { readNativeFeeFields } from './fees';
import { NativeReown } from './native';

jest.mock('./fees', () => ({
  readNativeFeeFields: jest.fn()
}));

jest.mock('./native', () => ({
  ...jest.requireActual('./native'),
  NativeReown: { sendTransaction: jest.fn() }
}));

const TEST_ABI = parseAbi(['function transfer(address to, uint256 amount) payable returns (bool)']);
const CONTRACT = '0x1111111111111111111111111111111111111111' as const;
const FROM = '0x2222222222222222222222222222222222222222' as const;
const RECIPIENT = '0x3333333333333333333333333333333333333333' as const;
const TX_HASH: Hash = `0x${'a'.repeat(64)}`;
const WALLET_RAISED = Symbol.for('miden.bridge-receive.wallet-raised');

describe('sendEvmContractTransaction', () => {
  const writeContract = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(readNativeFeeFields).mockResolvedValue({
      maxFeePerGas: '0x2540be400',
      maxPriorityFeePerGas: '0x5f5e100'
    });
    jest.mocked(NativeReown.sendTransaction).mockResolvedValue({ hash: TX_HASH });
    writeContract.mockResolvedValue(TX_HASH);
  });

  it('sends an encoded native Reown transaction with fee headroom and unwraps JSON-quoted hashes', async () => {
    jest.mocked(NativeReown.sendTransaction).mockResolvedValueOnce({ hash: JSON.stringify(TX_HASH) });

    const hash = await sendEvmContractTransaction({
      nativeReownAvailable: true,
      writeContract,
      chainId: 84532,
      from: FROM,
      address: CONTRACT,
      abi: TEST_ABI,
      functionName: 'transfer',
      args: [RECIPIENT, 42n]
    });

    expect(hash).toBe(TX_HASH);
    expect(writeContract).not.toHaveBeenCalled();
    expect(readNativeFeeFields).toHaveBeenCalledWith(84532);
    expect(NativeReown.sendTransaction).toHaveBeenCalledWith({
      chainId: 84532,
      from: FROM,
      to: CONTRACT,
      value: '0x0',
      data: encodeFunctionData({ abi: TEST_ABI, functionName: 'transfer', args: [RECIPIENT, 42n] }),
      maxFeePerGas: '0x2540be400',
      maxPriorityFeePerGas: '0x5f5e100'
    });
  });

  it('omits from when undefined and encodes zero value on native Reown', async () => {
    await sendEvmContractTransaction({
      nativeReownAvailable: true,
      writeContract,
      chainId: 11155111,
      address: CONTRACT,
      abi: TEST_ABI,
      functionName: 'transfer',
      args: [RECIPIENT, 10n]
    });

    const sentPayload = jest.mocked(NativeReown.sendTransaction).mock.calls[0]![0];
    expect(sentPayload).not.toHaveProperty('from');
    expect(sentPayload.value).toBe('0x0');
  });

  it('runs beforeSend after fee reads and skips NativeReown if fee reads fail', async () => {
    const order: string[] = [];
    jest.mocked(readNativeFeeFields).mockImplementationOnce(async () => {
      order.push('fees');
      return {};
    });
    jest.mocked(NativeReown.sendTransaction).mockImplementationOnce(async () => {
      order.push('send');
      return { hash: TX_HASH };
    });

    await sendEvmContractTransaction({
      nativeReownAvailable: true,
      writeContract,
      chainId: 84532,
      address: CONTRACT,
      abi: TEST_ABI,
      functionName: 'transfer',
      args: [RECIPIENT, 1n],
      beforeSend: async () => {
        order.push('beforeSend');
      }
    });

    expect(order).toEqual(['fees', 'beforeSend', 'send']);
  });

  it('skips beforeSend and both signers when native fee reads fail', async () => {
    jest.mocked(readNativeFeeFields).mockRejectedValueOnce(new Error('rpc down'));
    const skippedBeforeSend = jest.fn();

    await expect(
      sendEvmContractTransaction({
        nativeReownAvailable: true,
        writeContract,
        chainId: 84532,
        address: CONTRACT,
        abi: TEST_ABI,
        functionName: 'transfer',
        args: [RECIPIENT, 1n],
        beforeSend: skippedBeforeSend
      })
    ).rejects.toThrow('rpc down');

    expect(skippedBeforeSend).not.toHaveBeenCalled();
    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('uses wagmi writeContract without reading native fees when native Reown is unavailable', async () => {
    const order: string[] = [];
    writeContract.mockImplementationOnce(async () => {
      order.push('write');
      return TX_HASH;
    });

    const hash = await sendEvmContractTransaction({
      nativeReownAvailable: false,
      writeContract,
      chainId: 11155111,
      from: FROM,
      address: CONTRACT,
      abi: TEST_ABI,
      functionName: 'transfer',
      args: [RECIPIENT, 99n],
      beforeSend: async () => {
        order.push('beforeSend');
      }
    });

    expect(hash).toBe(TX_HASH);
    expect(order).toEqual(['beforeSend', 'write']);
    expect(readNativeFeeFields).not.toHaveBeenCalled();
    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledWith({
      chainId: 11155111,
      abi: TEST_ABI,
      address: CONTRACT,
      functionName: 'transfer',
      args: [RECIPIENT, 99n]
    });
    expect(writeContract.mock.calls[0]?.[0]).not.toHaveProperty('value');
  });

  it.each([true, false])(
    'propagates beforeSend rejection without invoking either signer (native=%s)',
    async nativeReownAvailable => {
      const refusal = new Error('reserve failed');
      const beforeSend = jest.fn().mockRejectedValueOnce(refusal);

      const thrown: unknown = await sendEvmContractTransaction({
        nativeReownAvailable,
        writeContract,
        chainId: 84532,
        address: CONTRACT,
        abi: TEST_ABI,
        functionName: 'transfer',
        args: [RECIPIENT, 5n],
        beforeSend
      }).catch(error => error);

      expect(thrown).toBe(refusal);
      expect(beforeSend).toHaveBeenCalledTimes(1);
      expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
      expect(writeContract).not.toHaveBeenCalled();
      expect(readNativeFeeFields).toHaveBeenCalledTimes(nativeReownAvailable ? 1 : 0);
    }
  );

  it.each([
    { nativeReownAvailable: true, label: 'invalid uint256', recipient: RECIPIENT, amount: -1n },
    { nativeReownAvailable: false, label: 'invalid uint256', recipient: RECIPIENT, amount: -1n },
    { nativeReownAvailable: true, label: 'invalid address', recipient: '0x1234' as const, amount: 1n },
    { nativeReownAvailable: false, label: 'invalid address', recipient: '0x1234' as const, amount: 1n }
  ])(
    'rejects $label encoding errors before fee reads, beforeSend, or signers (native=$nativeReownAvailable)',
    async ({ nativeReownAvailable, recipient, amount }) => {
      const beforeSend = jest.fn();

      const thrown: unknown = await sendEvmContractTransaction({
        nativeReownAvailable,
        writeContract,
        chainId: 84532,
        address: CONTRACT,
        abi: TEST_ABI,
        functionName: 'transfer',
        args: [recipient, amount],
        beforeSend
      }).catch(error => error);

      if (!(thrown instanceof Error)) throw new Error('Expected Error instance');
      expect(Reflect.get(thrown, WALLET_RAISED)).toBeUndefined();
      expect(readNativeFeeFields).not.toHaveBeenCalled();
      expect(beforeSend).not.toHaveBeenCalled();
      expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
      expect(writeContract).not.toHaveBeenCalled();
    }
  );

  it.each([
    { native: true, returned: 'not-a-hash' },
    { native: true, returned: '' },
    { native: true, returned: '123' },
    { native: true, returned: JSON.stringify('123') },
    { native: true, returned: 'null' },
    { native: true, returned: JSON.stringify('null') },
    { native: false, returned: 'not-a-hash' },
    { native: false, returned: '' },
    { native: false, returned: undefined },
    { native: false, returned: null },
    { native: false, returned: 123 }
  ])('throws a wallet-raised error when signer returns an invalid hash ($#)', async ({ native, returned }) => {
    if (native) {
      if (typeof returned !== 'string') throw new Error('Expected string mock hash for native case');
      jest.mocked(NativeReown.sendTransaction).mockResolvedValueOnce({ hash: returned });
    } else {
      writeContract.mockResolvedValueOnce(returned);
    }

    const thrown = await sendEvmContractTransaction({
      nativeReownAvailable: native,
      writeContract,
      chainId: 84532,
      address: CONTRACT,
      abi: TEST_ABI,
      functionName: 'transfer',
      args: [RECIPIENT, 1n]
    }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('The wallet returned no transaction hash.');
    expect(Reflect.get(thrown as object, WALLET_RAISED)).toBe(true);
  });
});
