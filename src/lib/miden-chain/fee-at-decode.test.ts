import { isSummaryFeeUnknownAtDecode } from './fee-at-decode';

const mockFee: { scope: string; fee: number | null; absent: boolean } = {
  scope: 'rpc-a|testnet',
  fee: 2,
  absent: false
};
jest.mock('lib/miden-chain/native-asset', () => ({
  cacheScope: () => mockFee.scope,
  getVerificationBaseFeeSync: () => mockFee.fee,
  isVerificationBaseFeeKnownAbsent: () => mockFee.absent
}));

beforeEach(() => {
  Object.assign(mockFee, { scope: 'rpc-a|testnet', fee: 2, absent: false });
});

describe('isSummaryFeeUnknownAtDecode', () => {
  it('answers known for a known fee on the scope of the fee read', () => {
    expect(isSummaryFeeUnknownAtDecode('rpc-a|testnet')).toBe(false);
    mockFee.fee = 0;
    expect(isSummaryFeeUnknownAtDecode('rpc-a|testnet')).toBe(false);
    // @ts-expect-error a fee scope is required
    isSummaryFeeUnknownAtDecode();
  });

  it('answers unknown on another scope than the fee read, even with a known fee', () => {
    mockFee.scope = 'rpc-b|testnet';
    expect(isSummaryFeeUnknownAtDecode('rpc-a|testnet')).toBe(true);
  });

  it('answers unknown for a fee the cache does not hold and the probe has not found absent', () => {
    mockFee.fee = null;
    expect(isSummaryFeeUnknownAtDecode('rpc-a|testnet')).toBe(true);
  });

  it('answers known for a fee the probe found absent', () => {
    mockFee.fee = null;
    mockFee.absent = true;
    expect(isSummaryFeeUnknownAtDecode('rpc-a|testnet')).toBe(false);
  });
});
