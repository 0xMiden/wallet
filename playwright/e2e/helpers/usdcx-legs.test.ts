/** @jest-environment node */
import { decodeBurnTerms, type UsdcxWalletIds } from './usdcx-legs';
import { burnOutputs } from './usdcx-miden';

jest.mock('./usdcx-miden', () => ({ burnOutputs: jest.fn() }));

const burnNoteId = '0x01';
const ids: UsdcxWalletIds = {
  address: 'sender',
  bare: 'sender-bare',
  accountHex: '0x03',
  native: 'native',
  nativeBare: 'native-bare',
  nativeHex: '0x04',
  baseFee: 7
};
const row = { id: 'burn-row', status: 2, feeFaucetId: ids.native };

beforeEach(() => {
  jest.mocked(burnOutputs).mockResolvedValue({
    burn: { noteId: burnNoteId, amount: 10_000n },
    sponsorship: { noteId: '0x02', amount: 119n },
    fee: { noteId: '0x03', amount: 112n }
  });
});

it('matches the recorded total but returns verification and sponsorship separately', async () => {
  await expect(decodeBurnTerms('AQ==', { ...row, feeAmount: '231' }, burnNoteId, ids, 10_000n, 119n)).resolves.toEqual({
    fee: 112n,
    sponsorship: 119n
  });
});

it('rejects a row that records only the verification fee', async () => {
  await expect(decodeBurnTerms('AQ==', { ...row, feeAmount: '112' }, burnNoteId, ids, 10_000n, 119n)).rejects.toThrow(
    /row feeAmount 112/
  );
});
