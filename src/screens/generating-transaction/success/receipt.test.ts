import { buildReceiptRows } from './receipt';

const t = (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key;

describe('buildReceiptRows', () => {
  it('shows the network fee the transaction paid', () => {
    // The fee leaves the vault on every transaction, so a receipt that omits it
    // understates what the transfer cost.
    const rows = buildReceiptRows(t, { amountText: '5 TKN', feeText: '0.17 MIDEN' });
    const fee = rows.find(row => row.label === 'Network Fee');
    expect(fee?.value).toBe('0.17 MIDEN');
  });

  it('omits the fee row when the transaction paid none', () => {
    // Zero-fee chains create no fee note at all; an empty row would imply the
    // wallet simply failed to read it.
    const rows = buildReceiptRows(t, { amountText: '5 TKN' });
    expect(rows.find(row => row.label === 'Network Fee')).toBeUndefined();
  });

  it('places the fee after the amount and before the transaction id', () => {
    const rows = buildReceiptRows(t, {
      amountText: '5 TKN',
      feeText: '0.17 MIDEN',
      txHash: '0xabc'
    });
    const labels = rows.map(row => row.label);
    expect(labels.indexOf('Network Fee')).toBeGreaterThan(labels.indexOf('Total Paid'));
    expect(labels.indexOf('Network Fee')).toBeLessThan(labels.indexOf('Transaction ID'));
  });
});
