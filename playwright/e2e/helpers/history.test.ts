/**
 * @jest-environment node
 */
import { describeTransactionRow, TxStatus } from './history';

it('names the Unconfirmed status instead of printing its number', () => {
  expect(TxStatus.Unconfirmed).toBe(4);
  expect(describeTransactionRow({ id: 'r1', status: 4 })).toContain(' Unconfirmed ');
});
